#include "../src/InnertubeProvider.hpp"
#include "../src/YoutubeHttpAudioDevice.hpp"
#include "../src/YoutubePlaybackResolver.hpp"
#include "../src/YoutubeStreamBuffer.hpp"
#include "../src/YoutubeUmpParser.hpp"

#include <QFile>
#include <QSignalSpy>
#include <QStringView>
#include <QTcpServer>
#include <QTcpSocket>
#include <QTest>
#include <QUrl>

#include <atomic>
#include <chrono>
#include <cstring>
#include <thread>

namespace {

QString projectSourcePath(QStringView relativePath) {
    return QStringLiteral(AUQW_PROJECT_SOURCE_DIR) + QLatin1Char('/') + relativePath.toString();
}

QString readTextFile(QStringView relativePath) {
    QFile file(projectSourcePath(relativePath));
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return {};
    }
    return QString::fromUtf8(file.readAll());
}

} // namespace

class OnlineProviderTest final : public QObject {
    Q_OBJECT

private slots:
    void innertubeCapabilitiesEnableDownloads();
    void parsesTrackShelfFixture();
    void parsesSearchSuggestionsFixture();
    void parsesTrackMetadataFixture();
    void ignoresMalformedItems();
    void reportsInvalidJsonAsFriendlyError();
    void liveSmokeExposesSoakControls();
    void livePlaybackSoakScriptDrivesManualMatrix();
    void livePlaybackSoakRequiresMultimediaForPlayback();
    void playbackClientProfilesPreferAndroidVr();
    void parsesAndroidVrDirectAudioStreamFixture();
    void parsesDirectAudioStreamFixture();
    void parsesSabrOnlyAudioStreamFixture();
    void parsesSabrStreamWithExternalUstreamerConfig();
    void ignoresVideoOnlyStreamFormats();
    void reportsCipherOnlyStreamsAsUnavailable();
    void parsesUmpMediaPartsInOrder();
    void parsesUmpDirectiveParts();
    void reportsMalformedUmpFrame();
    void streamBufferWaitsForBytesAndCancelWakesReader();
    void httpAudioDeviceResumesAfterShortNetworkReply();
    void httpAudioDeviceContinuesAfterCompletePartialSegment();
};

void OnlineProviderTest::innertubeCapabilitiesEnableDownloads() {
        InnertubeProvider provider;

        const OnlineProviderCapabilities capabilities = provider.capabilities();

        QVERIFY(capabilities.search);
        QVERIFY(capabilities.suggestions);
        QVERIFY(capabilities.metadata);
        QVERIFY(capabilities.playback);
        QVERIFY(capabilities.downloads);
}

void OnlineProviderTest::parsesTrackShelfFixture() {
        const QByteArray payload = R"json(
{
  "contents": {
    "tabbedSearchResultsRenderer": {
      "tabs": [
        {
          "tabRenderer": {
            "content": {
              "sectionListRenderer": {
                "contents": [
                  {
                    "musicShelfRenderer": {
                      "contents": [
                        {
                          "musicResponsiveListItemRenderer": {
                            "playlistItemData": { "videoId": "video-alpha" },
                            "thumbnail": {
                              "musicThumbnailRenderer": {
                                "thumbnail": {
                                  "thumbnails": [
                                    { "url": "https://img.example/small.jpg" },
                                    { "url": "https://img.example/large.jpg" }
                                  ]
                                }
                              }
                            },
                            "flexColumns": [
                              {
                                "musicResponsiveListItemFlexColumnRenderer": {
                                  "text": { "runs": [ { "text": "Stone Window" } ] }
                                }
                              },
                              {
                                "musicResponsiveListItemFlexColumnRenderer": {
                                  "text": {
                                    "runs": [
                                      { "text": "Aster Band" },
                                      { "text": " | " },
                                      { "text": "Blue Album" }
                                    ]
                                  }
                                }
                              }
                            ],
                            "fixedColumns": [
                              {
                                "musicResponsiveListItemFixedColumnRenderer": {
                                  "text": { "runs": [ { "text": "3:33" } ] }
                                }
                              }
                            ]
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    }
  }
}
)json";

        const OnlineSearchParseResult parsed = InnertubeProvider::parseTrackSearchResults(payload);

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QCOMPARE(parsed.tracks.size(), 1);
        QCOMPARE(parsed.tracks.first().provider, QStringLiteral("ytmusic"));
        QCOMPARE(parsed.tracks.first().providerTrackId, QStringLiteral("video-alpha"));
        QCOMPARE(parsed.tracks.first().resultId, QStringLiteral("ytmusic:video-alpha"));
        QCOMPARE(parsed.tracks.first().title, QStringLiteral("Stone Window"));
        QCOMPARE(parsed.tracks.first().artist, QStringLiteral("Aster Band"));
        QCOMPARE(parsed.tracks.first().album, QStringLiteral("Blue Album"));
        QCOMPARE(parsed.tracks.first().durationMs, 213000);
        QCOMPARE(parsed.tracks.first().artworkUrl, QStringLiteral("https://img.example/large.jpg"));
}

void OnlineProviderTest::parsesSearchSuggestionsFixture() {
        const QByteArray payload = R"json(
{
  "contents": [
    {
      "searchSuggestionsSectionRenderer": {
        "contents": [
          {
            "searchSuggestionRenderer": {
              "suggestion": { "runs": [ { "text": "stone window" } ] }
            }
          },
          {
            "searchSuggestionRenderer": {
              "suggestion": { "simpleText": "stone window live" }
            }
          }
        ]
      }
    }
  ]
}
)json";

        const OnlineSuggestionsParseResult parsed = InnertubeProvider::parseSearchSuggestions(payload);

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QCOMPARE(parsed.suggestions.size(), 2);
        QCOMPARE(parsed.suggestions.at(0).provider, QStringLiteral("ytmusic"));
        QCOMPARE(parsed.suggestions.at(0).text, QStringLiteral("stone window"));
        QCOMPARE(parsed.suggestions.at(1).text, QStringLiteral("stone window live"));
}

void OnlineProviderTest::parsesTrackMetadataFixture() {
        const QByteArray payload = R"json(
{
  "videoDetails": {
    "videoId": "video-alpha",
    "title": "Stone Window",
    "author": "Aster Band",
    "lengthSeconds": "213",
    "thumbnail": {
      "thumbnails": [
        { "url": "https://img.example/small.jpg" },
        { "url": "https://img.example/large.jpg" }
      ]
    }
  }
}
)json";

        const OnlineTrackMetadataParseResult parsed = InnertubeProvider::parseTrackMetadata(payload, QStringLiteral("video-alpha"));

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QCOMPARE(parsed.metadata.provider, QStringLiteral("ytmusic"));
        QCOMPARE(parsed.metadata.providerTrackId, QStringLiteral("video-alpha"));
        QCOMPARE(parsed.metadata.title, QStringLiteral("Stone Window"));
        QCOMPARE(parsed.metadata.artist, QStringLiteral("Aster Band"));
        QCOMPARE(parsed.metadata.durationMs, 213000);
        QCOMPARE(parsed.metadata.artworkUrl, QStringLiteral("https://img.example/large.jpg"));
}

void OnlineProviderTest::ignoresMalformedItems() {
        const QByteArray payload = R"json(
{
  "contents": {
    "tabbedSearchResultsRenderer": {
      "tabs": [
        {
          "tabRenderer": {
            "content": {
              "sectionListRenderer": {
                "contents": [
                  {
                    "musicShelfRenderer": {
                      "contents": [
                        { "musicResponsiveListItemRenderer": { "flexColumns": [] } },
                        {
                          "musicResponsiveListItemRenderer": {
                            "playlistItemData": { "videoId": "video-beta" },
                            "flexColumns": [
                              {
                                "musicResponsiveListItemFlexColumnRenderer": {
                                  "text": { "runs": [ { "text": "Clean Result" } ] }
                                }
                              },
                              {
                                "musicResponsiveListItemFlexColumnRenderer": {
                                  "text": { "runs": [ { "text": "One Artist" } ] }
                                }
                              }
                            ]
                          }
                        }
                      ]
                    }
                  }
                ]
              }
            }
          }
        }
      ]
    }
  }
}
)json";

        const OnlineSearchParseResult parsed = InnertubeProvider::parseTrackSearchResults(payload);

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QCOMPARE(parsed.tracks.size(), 1);
        QCOMPARE(parsed.tracks.first().providerTrackId, QStringLiteral("video-beta"));
        QCOMPARE(parsed.tracks.first().title, QStringLiteral("Clean Result"));
        QCOMPARE(parsed.tracks.first().artist, QStringLiteral("One Artist"));
}

void OnlineProviderTest::reportsInvalidJsonAsFriendlyError() {
        const OnlineSearchParseResult parsed = InnertubeProvider::parseTrackSearchResults("{");

        QVERIFY(!parsed.ok);
        QCOMPARE(parsed.errorMessage, QStringLiteral("Provider returned invalid search data."));
        QVERIFY(parsed.tracks.isEmpty());
}

void OnlineProviderTest::liveSmokeExposesSoakControls() {
        const QString smoke = readTextFile(u"auqw-qt/tests/youtube_sabr_live_smoke.cpp");

        QVERIFY2(!smoke.isEmpty(), "live smoke source should be readable");
        QVERIFY2(smoke.contains(QStringLiteral("AUQW_SABR_SMOKE_MAX_RESULTS")),
            "live smoke should allow trying more than the first search result");
        QVERIFY2(smoke.contains(QStringLiteral("AUQW_SABR_SMOKE_MIN_POSITION_MS")),
            "playback smoke should make progress threshold configurable");
        QVERIFY2(smoke.contains(QStringLiteral("AUQW_SABR_SMOKE_PLAYBACK_WINDOW_MS")),
            "playback smoke should make playback observation window configurable");
        QVERIFY2(smoke.contains(QStringLiteral("result_attempt=")),
            "live smoke should log which search result attempt is running");
        QVERIFY2(smoke.contains(QStringLiteral("status=all_results_failed")),
            "live smoke should report matrix exhaustion distinctly");
        QVERIFY2(smoke.contains(QStringLiteral("playback_stopped_early")),
            "playback smoke should fail fast when a stream stops before the configured progress threshold");
}

void OnlineProviderTest::livePlaybackSoakScriptDrivesManualMatrix() {
        const QString script = readTextFile(u"ci/live-playback-soak.sh");

        QVERIFY2(!script.isEmpty(), "manual live playback soak script should be readable");
        QVERIFY2(script.contains(QStringLiteral("--runs")), "soak script should expose run count");
        QVERIFY2(script.contains(QStringLiteral("--max-results")), "soak script should expose per-query result breadth");
        QVERIFY2(script.contains(QStringLiteral("--playback")), "soak script should expose Qt Multimedia playback mode");
        QVERIFY2(script.contains(QStringLiteral("AUQW_SABR_SMOKE_MAX_RESULTS")),
            "soak script should pass result breadth into live smoke binary");
        QVERIFY2(script.contains(QStringLiteral("around the world")),
            "soak script should include release-relevant default queries");
        QVERIFY2(script.contains(QStringLiteral("blinding lights")),
            "soak script should include multiple default query shapes");
}

void OnlineProviderTest::livePlaybackSoakRequiresMultimediaForPlayback() {
        const QString script = readTextFile(u"ci/live-playback-soak.sh");

        QVERIFY2(!script.isEmpty(), "manual live playback soak script should be readable");
        QVERIFY2(script.contains(QStringLiteral("AUQW_REQUIRE_QT_MULTIMEDIA=ON")),
            "playback soak should force a multimedia-required build");
        QVERIFY2(script.contains(QStringLiteral("ldd \"$smoke_bin\"")),
            "playback soak should inspect the existing smoke binary linkage on Linux");
        QVERIFY2(script.contains(QStringLiteral("libQt6Multimedia.so.6")),
            "playback soak should reject non-multimedia Linux smoke binaries");
}

void OnlineProviderTest::playbackClientProfilesPreferAndroidVr() {
        const QVector<YoutubeClientProfile> profiles = YoutubePlaybackResolver::playbackClientProfiles();

        QVERIFY(!profiles.isEmpty());
        QCOMPARE(profiles.first().key, QStringLiteral("ANDROID_VR_NO_AUTH"));
        QCOMPARE(profiles.first().clientName, QStringLiteral("ANDROID_VR"));
        QCOMPARE(profiles.first().clientVersion, QStringLiteral("1.37"));
        QCOMPARE(profiles.first().clientId, QStringLiteral("28"));
        QVERIFY(!profiles.first().userAgent.isEmpty());
}

void OnlineProviderTest::parsesAndroidVrDirectAudioStreamFixture() {
        const YoutubeClientProfile profile = YoutubePlaybackResolver::playbackClientProfiles().first();
        const QByteArray payload = R"json(
{
  "playabilityStatus": { "status": "OK" },
  "streamingData": {
    "expiresInSeconds": "21540",
    "adaptiveFormats": [
      {
        "itag": 140,
        "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"",
        "bitrate": 130632,
        "url": "https://rr1.example/videoplayback?itag=140&c=ANDROID_VR&cver=1.37"
      },
      {
        "itag": 251,
        "mimeType": "audio/webm; codecs=\"opus\"",
        "bitrate": 139866,
        "url": "https://rr1.example/videoplayback?itag=251&c=ANDROID_VR&cver=1.37"
      }
    ]
  }
}
)json";

        const OnlineStreamResolveResult parsed =
            YoutubePlaybackResolver::parsePlayerResponse(payload, QStringLiteral("video-alpha"), profile);

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QCOMPARE(parsed.stream.streamKind, OnlineStreamKind::HeaderedDirectUrl);
        QVERIFY(!parsed.stream.isSabr);
        QCOMPARE(parsed.stream.provider, QStringLiteral("ytmusic"));
        QCOMPARE(parsed.stream.providerTrackId, QStringLiteral("video-alpha"));
        QCOMPARE(parsed.stream.streamUrl, QUrl(QStringLiteral("https://rr1.example/videoplayback?itag=140&c=ANDROID_VR&cver=1.37")));
        QCOMPARE(parsed.stream.mimeType, QStringLiteral("audio/mp4; codecs=\"mp4a.40.2\""));
        QCOMPARE(parsed.stream.clientName, QStringLiteral("ANDROID_VR"));
        QCOMPARE(parsed.stream.clientVersion, QStringLiteral("1.37"));
        QCOMPARE(parsed.stream.itag, 140);
        QVERIFY(parsed.stream.expiresAtMs > 0);
        QVERIFY(!parsed.stream.requestHeaders.isEmpty());
}

void OnlineProviderTest::parsesDirectAudioStreamFixture() {
        const QByteArray payload = R"json(
{
  "streamingData": {
    "adaptiveFormats": [
      {
        "itag": 248,
        "mimeType": "video/webm; codecs=\"vp9\"",
        "url": "https://video.example/play"
      },
      {
        "itag": 140,
        "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"",
        "bitrate": 128000,
        "url": "https://audio.example/low.m4a"
      },
      {
        "itag": 251,
        "mimeType": "audio/webm; codecs=\"opus\"",
        "bitrate": 160000,
        "url": "https://audio.example/high.webm"
      }
    ]
  }
}
)json";

        const OnlineStreamResolveResult parsed = InnertubeProvider::parseStreamResolution(payload, QStringLiteral("video-alpha"));

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QCOMPARE(parsed.stream.provider, QStringLiteral("ytmusic"));
        QCOMPARE(parsed.stream.providerTrackId, QStringLiteral("video-alpha"));
        QCOMPARE(parsed.stream.streamUrl, QUrl(QStringLiteral("https://audio.example/low.m4a")));
        QCOMPARE(parsed.stream.mimeType, QStringLiteral("audio/mp4; codecs=\"mp4a.40.2\""));
}

void OnlineProviderTest::parsesSabrOnlyAudioStreamFixture() {
        const QByteArray payload = R"json(
{
  "responseContext": {
    "visitorData": "visitor-token"
  },
  "streamingData": {
    "serverAbrStreamingUrl": "https://rr1---sn.example/videoplayback?sabr=1",
    "mediaUstreamerRequestConfig": {
      "videoPlaybackUstreamerConfig": "dXN0cmVhbWVy"
    },
    "adaptiveFormats": [
      {
        "itag": 140,
        "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"",
        "bitrate": 128000,
        "audioQuality": "AUDIO_QUALITY_MEDIUM",
        "lastModified": "1780000000000000",
        "xtags": "acont=original"
      },
      {
        "itag": 251,
        "mimeType": "audio/webm; codecs=\"opus\"",
        "bitrate": 160000,
        "audioQuality": "AUDIO_QUALITY_MEDIUM",
        "audioTrackId": "eng.0",
        "lastModified": "1780000000000001",
        "xtags": "acont=original"
      }
    ]
  }
}
)json";

        const OnlineStreamResolveResult parsed = InnertubeProvider::parseStreamResolution(payload, QStringLiteral("video-sabr"));

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QVERIFY(parsed.stream.isSabr);
        QVERIFY(parsed.stream.streamUrl.isEmpty());
        QCOMPARE(parsed.stream.mimeType, QStringLiteral("audio/webm; codecs=\"opus\""));
        QCOMPARE(parsed.stream.sabr.serverAbrStreamingUrl, QUrl(QStringLiteral("https://rr1---sn.example/videoplayback?sabr=1")));
        QCOMPARE(parsed.stream.sabr.videoPlaybackUstreamerConfig, QStringLiteral("dXN0cmVhbWVy"));
        QCOMPARE(parsed.stream.sabr.visitorData, QStringLiteral("visitor-token"));
        QCOMPARE(parsed.stream.sabr.audioFormats.size(), 2);
        QCOMPARE(parsed.stream.sabr.audioFormats.first().itag, 140);
        QCOMPARE(parsed.stream.sabr.audioFormats.last().itag, 251);
        QCOMPARE(parsed.stream.sabr.audioFormats.last().audioTrackId, QStringLiteral("eng.0"));
        QCOMPARE(parsed.stream.sabr.audioFormats.last().lastModified, 1780000000000001LL);
}

void OnlineProviderTest::parsesSabrStreamWithExternalUstreamerConfig() {
        const QByteArray payload = R"json(
{
  "streamingData": {
    "serverAbrStreamingUrl": "https://rr1---sn.example/videoplayback?sabr=1",
    "adaptiveFormats": [
      {
        "itag": 251,
        "mimeType": "audio/webm; codecs=\"opus\"",
        "bitrate": 160000
      }
    ]
  }
}
)json";

        const OnlineStreamResolveResult parsed = InnertubeProvider::parseStreamResolution(payload, QStringLiteral("video-sabr"));

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QVERIFY(parsed.stream.isSabr);
        QCOMPARE(parsed.stream.sabr.serverAbrStreamingUrl, QUrl(QStringLiteral("https://rr1---sn.example/videoplayback?sabr=1")));
        QCOMPARE(parsed.stream.sabr.videoPlaybackUstreamerConfig, QString{});
        QCOMPARE(parsed.stream.sabr.audioFormats.size(), 1);
        QCOMPARE(parsed.stream.sabr.audioFormats.first().itag, 251);
}

void OnlineProviderTest::ignoresVideoOnlyStreamFormats() {
        const QByteArray payload = R"json(
{
  "streamingData": {
    "adaptiveFormats": [
      {
        "itag": 248,
        "mimeType": "video/webm; codecs=\"vp9\"",
        "bitrate": 500000,
        "url": "https://video.example/play"
      },
      {
        "itag": 140,
        "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"",
        "bitrate": 64000,
        "url": "https://audio.example/play.m4a"
      }
    ]
  }
}
)json";

        const OnlineStreamResolveResult parsed = InnertubeProvider::parseStreamResolution(payload, QStringLiteral("video-beta"));

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QCOMPARE(parsed.stream.streamUrl, QUrl(QStringLiteral("https://audio.example/play.m4a")));
        QVERIFY(parsed.stream.mimeType.startsWith(QStringLiteral("audio/")));
}

void OnlineProviderTest::reportsCipherOnlyStreamsAsUnavailable() {
        const QByteArray payload = R"json(
{
  "streamingData": {
    "adaptiveFormats": [
      {
        "itag": 140,
        "mimeType": "audio/mp4; codecs=\"mp4a.40.2\"",
        "signatureCipher": "url=https%3A%2F%2Faudio.example%2Fcipher.m4a&s=abc"
      }
    ]
  }
}
)json";

        const OnlineStreamResolveResult parsed = InnertubeProvider::parseStreamResolution(payload, QStringLiteral("video-gamma"));

        QVERIFY(!parsed.ok);
        QCOMPARE(parsed.errorMessage, QStringLiteral("Online playback unavailable for this track."));
        QVERIFY(parsed.stream.streamUrl.isEmpty());
}

namespace {

QByteArray umpVarint(quint32 value) {
        QByteArray encoded;
        if (value < 128) {
            encoded.append(static_cast<char>(value));
        } else if (value < 16384) {
            encoded.append(static_cast<char>((value & 0x3f) | 0x80));
            encoded.append(static_cast<char>(value >> 6));
        } else if (value < 2097152) {
            encoded.append(static_cast<char>((value & 0x1f) | 0xc0));
            encoded.append(static_cast<char>((value >> 5) & 0xff));
            encoded.append(static_cast<char>(value >> 13));
        } else if (value < 268435456) {
            encoded.append(static_cast<char>((value & 0x0f) | 0xe0));
            encoded.append(static_cast<char>((value >> 4) & 0xff));
            encoded.append(static_cast<char>((value >> 12) & 0xff));
            encoded.append(static_cast<char>(value >> 20));
        } else {
            encoded.append(static_cast<char>(0xf0));
            encoded.append(static_cast<char>(value & 0xff));
            encoded.append(static_cast<char>((value >> 8) & 0xff));
            encoded.append(static_cast<char>((value >> 16) & 0xff));
            encoded.append(static_cast<char>((value >> 24) & 0xff));
        }
        return encoded;
}

QByteArray umpPart(quint32 type, const QByteArray& payload) {
        return umpVarint(type) + umpVarint(static_cast<quint32>(payload.size())) + payload;
}

QByteArray protoVarint(quint32 value) {
        QByteArray encoded;
        do {
            char byte = static_cast<char>(value & 0x7f);
            value >>= 7;
            if (value != 0) {
                byte = static_cast<char>(byte | 0x80);
            }
            encoded.append(byte);
        } while (value != 0);
        return encoded;
}

QByteArray protoString(quint32 field, const QString& value) {
        const QByteArray bytes = value.toUtf8();
        return protoVarint((field << 3) | 2) + protoVarint(static_cast<quint32>(bytes.size())) + bytes;
}

QByteArray protoVarintField(quint32 field, quint32 value) {
        return protoVarint(field << 3) + protoVarint(value);
}

} // namespace

void OnlineProviderTest::parsesUmpMediaPartsInOrder() {
        YoutubeUmpParser parser;
        QByteArray stream;
        QByteArray mediaA;
        mediaA.append('\x07');
        mediaA.append("abc", 3);
        QByteArray mediaB;
        mediaB.append('\x07');
        mediaB.append("def", 3);
        stream += umpPart(20, protoVarintField(1, 7) + protoVarintField(3, 251) + protoVarintField(9, 1) + protoVarintField(12, 2000));
        stream += umpPart(21, mediaA);
        stream += umpPart(21, mediaB);
        stream += umpPart(22, QByteArray("\x07", 1));

        const YoutubeUmpParseResult parsed = parser.append(stream);

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QCOMPARE(parsed.audioBytes, QByteArray("abcdef"));
        QCOMPARE(parsed.events.size(), 4);
        QCOMPARE(parsed.events.at(0).type, YoutubeUmpEventType::MediaHeader);
        QCOMPARE(parsed.events.at(0).mediaHeader.headerId, 7);
        QCOMPARE(parsed.events.at(0).mediaHeader.itag, 251);
        QCOMPARE(parsed.events.at(0).mediaHeader.sequenceNumber, 1);
        QCOMPARE(parsed.events.at(0).mediaHeader.durationMs, 2000);
        QCOMPARE(parsed.events.at(3).type, YoutubeUmpEventType::MediaEnd);
}

void OnlineProviderTest::parsesUmpDirectiveParts() {
        YoutubeUmpParser parser;
        QByteArray stream;
        stream += umpPart(43, protoString(1, QStringLiteral("https://rr2.example/sabr")));
        stream += umpPart(44, protoString(1, QStringLiteral("BAD_REQUEST")) + protoVarintField(2, 400));
        stream += umpPart(46, QByteArray("\x08\x01", 2));
        stream += umpPart(35, protoVarintField(4, 125) + protoVarint((7 << 3) | 2) + protoVarint(3) + QByteArray("tok", 3));
        stream += umpPart(58, protoVarintField(1, 2) + protoVarintField(2, 3));

        const YoutubeUmpParseResult parsed = parser.append(stream);

        QVERIFY2(parsed.ok, qPrintable(parsed.errorMessage));
        QCOMPARE(parsed.events.size(), 5);
        QCOMPARE(parsed.events.at(0).type, YoutubeUmpEventType::Redirect);
        QCOMPARE(parsed.events.at(0).text, QStringLiteral("https://rr2.example/sabr"));
        QCOMPARE(parsed.events.at(1).type, YoutubeUmpEventType::SabrError);
        QCOMPARE(parsed.events.at(1).text, QStringLiteral("BAD_REQUEST"));
        QCOMPARE(parsed.events.at(1).code, 400);
        QCOMPARE(parsed.events.at(2).type, YoutubeUmpEventType::ReloadPlayer);
        QCOMPARE(parsed.events.at(3).type, YoutubeUmpEventType::NextRequestPolicy);
        QCOMPARE(parsed.events.at(3).code, 125);
        QCOMPARE(parsed.events.at(3).bytes, QByteArray("tok", 3));
        QCOMPARE(parsed.events.at(4).type, YoutubeUmpEventType::StreamProtectionStatus);
        QCOMPARE(parsed.events.at(4).code, 2);
}

void OnlineProviderTest::reportsMalformedUmpFrame() {
        YoutubeUmpParser parser;
        const QByteArray badFrame = umpVarint(21) + umpVarint(268435456);

        const YoutubeUmpParseResult parsed = parser.append(badFrame);

        QVERIFY(!parsed.ok);
        QCOMPARE(parsed.errorMessage, QStringLiteral("Malformed UMP frame."));
}

void OnlineProviderTest::streamBufferWaitsForBytesAndCancelWakesReader() {
        YoutubeStreamBuffer buffer;
        char bytes[8] = {};
        std::atomic_bool readFinished = false;
        qint64 readCount = 0;

        std::thread reader([&] {
            readCount = buffer.read(bytes, sizeof(bytes));
            readFinished = true;
        });

        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        QVERIFY(!readFinished.load());

        buffer.append(QByteArrayLiteral("abcd"));
        reader.join();
        QCOMPARE(readCount, qint64(4));
        QCOMPARE(std::memcmp(bytes, "abcd", 4), 0);

        readFinished = false;
        readCount = 0;
        std::thread canceledReader([&] {
            readCount = buffer.read(bytes, sizeof(bytes));
            readFinished = true;
        });

        std::this_thread::sleep_for(std::chrono::milliseconds(50));
        QVERIFY(!readFinished.load());
        buffer.cancel();
        canceledReader.join();
        QVERIFY(readFinished.load());
        QCOMPARE(readCount, qint64(-1));

        buffer.reset();
        buffer.append(QByteArrayLiteral("xy"));
        buffer.finish();
        QCOMPARE(buffer.read(bytes, sizeof(bytes)), qint64(2));
        QCOMPARE(std::memcmp(bytes, "xy", 2), 0);
        QCOMPARE(buffer.read(bytes, sizeof(bytes)), qint64(-1));
}

void OnlineProviderTest::httpAudioDeviceResumesAfterShortNetworkReply() {
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost));
        QVector<QByteArray> ranges;
        int requestCount = 0;

        QObject::connect(&server, &QTcpServer::newConnection, &server, [&] {
            QTcpSocket* socket = server.nextPendingConnection();
            socket->setParent(&server);
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [&, socket] {
                const QByteArray request = socket->readAll();
                const QList<QByteArray> lines = request.split('\n');
                for (QByteArray line : lines) {
                    line = line.trimmed();
                    if (line.toLower().startsWith("range:")) {
                        ranges.push_back(line);
                    }
                }

                if (requestCount++ == 0) {
                    const QByteArray response =
                        "HTTP/1.1 206 Partial Content\r\n"
                        "Content-Length: 8\r\n"
                        "Content-Range: bytes 0-7/8\r\n"
                        "Connection: close\r\n"
                        "\r\n"
                        "abcd";
                    socket->write(response);
                } else {
                    const QByteArray response =
                        "HTTP/1.1 206 Partial Content\r\n"
                        "Content-Length: 4\r\n"
                        "Content-Range: bytes 4-7/8\r\n"
                        "Connection: close\r\n"
                        "\r\n"
                        "efgh";
                    socket->write(response);
                }
                socket->disconnectFromHost();
            });
        });

        YoutubeHttpAudioDevice device(
            QUrl(QStringLiteral("http://127.0.0.1:%1/audio").arg(server.serverPort())),
            {});
        QSignalSpy finished(&device, &QIODevice::readChannelFinished);
        QSignalSpy errors(&device, &YoutubeHttpAudioDevice::streamError);

        QVERIFY(device.open(QIODevice::ReadOnly));
        QTRY_COMPARE_WITH_TIMEOUT(finished.count(), 1, 5000);
        QCOMPARE(errors.count(), 0);

        QByteArray actual;
        char chunk[16] = {};
        while (true) {
            const qint64 count = device.read(chunk, sizeof(chunk));
            if (count < 0) {
                break;
            }
            actual.append(chunk, static_cast<qsizetype>(count));
        }

        QCOMPARE(actual, QByteArrayLiteral("abcdefgh"));
        QCOMPARE(ranges.size(), 2);
        QCOMPARE(ranges.at(0), QByteArrayLiteral("Range: bytes=0-"));
        QCOMPARE(ranges.at(1), QByteArrayLiteral("Range: bytes=4-"));
}

void OnlineProviderTest::httpAudioDeviceContinuesAfterCompletePartialSegment() {
        QTcpServer server;
        QVERIFY(server.listen(QHostAddress::LocalHost));
        QVector<QByteArray> ranges;
        int requestCount = 0;

        QObject::connect(&server, &QTcpServer::newConnection, &server, [&] {
            QTcpSocket* socket = server.nextPendingConnection();
            socket->setParent(&server);
            QObject::connect(socket, &QTcpSocket::readyRead, socket, [&, socket] {
                const QByteArray request = socket->readAll();
                const QList<QByteArray> lines = request.split('\n');
                for (QByteArray line : lines) {
                    line = line.trimmed();
                    if (line.toLower().startsWith("range:")) {
                        ranges.push_back(line);
                    }
                }

                if (requestCount++ == 0) {
                    const QByteArray response =
                        "HTTP/1.1 206 Partial Content\r\n"
                        "Content-Length: 4\r\n"
                        "Content-Range: bytes 0-3/8\r\n"
                        "Connection: close\r\n"
                        "\r\n"
                        "abcd";
                    socket->write(response);
                } else {
                    const QByteArray response =
                        "HTTP/1.1 206 Partial Content\r\n"
                        "Content-Length: 4\r\n"
                        "Content-Range: bytes 4-7/8\r\n"
                        "Connection: close\r\n"
                        "\r\n"
                        "efgh";
                    socket->write(response);
                }
                socket->disconnectFromHost();
            });
        });

        YoutubeHttpAudioDevice device(
            QUrl(QStringLiteral("http://127.0.0.1:%1/audio").arg(server.serverPort())),
            {});
        QSignalSpy finished(&device, &QIODevice::readChannelFinished);
        QSignalSpy errors(&device, &YoutubeHttpAudioDevice::streamError);

        QVERIFY(device.open(QIODevice::ReadOnly));
        QTRY_COMPARE_WITH_TIMEOUT(finished.count(), 1, 5000);
        QCOMPARE(errors.count(), 0);

        QByteArray actual;
        char chunk[16] = {};
        while (true) {
            const qint64 count = device.read(chunk, sizeof(chunk));
            if (count < 0) {
                break;
            }
            actual.append(chunk, static_cast<qsizetype>(count));
        }

        QCOMPARE(actual, QByteArrayLiteral("abcdefgh"));
        QCOMPARE(ranges.size(), 2);
        QCOMPARE(ranges.at(0), QByteArrayLiteral("Range: bytes=0-"));
        QCOMPARE(ranges.at(1), QByteArrayLiteral("Range: bytes=4-"));
}

QTEST_MAIN(OnlineProviderTest)

#include "online_provider_test.moc"
