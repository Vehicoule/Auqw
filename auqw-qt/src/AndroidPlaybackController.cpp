#include "AndroidPlaybackController.hpp"

#include "CoreController.hpp"

#include <QJniObject>

namespace {

constexpr auto bridgeClass = "com/Vehicoule/auqw/AuqwMediaSessionBridge";

void callBridgeSync(
    const QString& state,
    const QString& title,
    const QString& artist,
    const QString& album,
    qint64 positionMs,
    qint64 durationMs) {
    const QJniObject jState = QJniObject::fromString(state);
    const QJniObject jTitle = QJniObject::fromString(title);
    const QJniObject jArtist = QJniObject::fromString(artist);
    const QJniObject jAlbum = QJniObject::fromString(album);

    QJniObject::callStaticMethod<void>(
        bridgeClass,
        "sync",
        "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;JJ)V",
        jState.object<jstring>(),
        jTitle.object<jstring>(),
        jArtist.object<jstring>(),
        jAlbum.object<jstring>(),
        static_cast<jlong>(positionMs),
        static_cast<jlong>(durationMs));
}

} // namespace

AndroidPlaybackController::AndroidPlaybackController(CoreController& coreController, QObject* parent)
    : QObject(parent),
      coreController_(coreController) {
    connect(&coreController_, &CoreController::playbackStateChanged, this, &AndroidPlaybackController::syncPlaybackState);

    QJniObject::callStaticMethod<void>(bridgeClass, "ensureSession", "()V");
    syncPlaybackState();
}

AndroidPlaybackController::~AndroidPlaybackController() {
    QJniObject::callStaticMethod<void>(bridgeClass, "shutdown", "()V");
}

void AndroidPlaybackController::syncPlaybackState() const {
    callBridgeSync(
        coreController_.playbackState(),
        coreController_.playbackTitle(),
        coreController_.playbackArtist(),
        coreController_.playbackAlbum(),
        coreController_.playbackPositionMs(),
        coreController_.playbackDurationMs());
}
