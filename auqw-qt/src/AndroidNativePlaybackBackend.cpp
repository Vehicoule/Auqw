#include "PlaybackBackend.hpp"

#if AUQW_ENABLE_ANDROID_PLATFORM

#include <QJniObject>
#include <QMetaObject>
#include <QMutex>
#include <QMutexLocker>
#include <QObject>
#include <QUrl>

#include <jni.h>

#include <memory>
#include <optional>
#include <utility>

namespace {

constexpr auto nativePlayerClass = "com/Vehicoule/auqw/AuqwNativeAudioPlayer";

class AndroidNativePlaybackBackend final : public QObject, public PlaybackBackend {
public:
    explicit AndroidNativePlaybackBackend(std::unique_ptr<PlaybackBackend> fallback)
        : fallback_(std::move(fallback)) {
        setActiveBackend(this);
        if (fallback_) {
            fallback_->setStateChangedCallback([this](const PlaybackBackendState& state) {
                if (!nativePlaybackActive_) {
                    emitState(state.state, state.positionMs, state.durationMs);
                }
            });
            fallback_->setErrorCallback([this](const QString& message) {
                if (!nativePlaybackActive_) {
                    emitError(message);
                }
            });
        }
    }

    ~AndroidNativePlaybackBackend() override {
        clearActiveBackend(this);
        QJniObject::callStaticMethod<void>(nativePlayerClass, "shutdown", "()V");
    }

    void playLocalFile(const QString& path) override {
        stopNativePlayback(false);
        if (fallback_) {
            fallback_->playLocalFile(path);
            return;
        }
        emitError(QStringLiteral("Qt Multimedia unavailable"));
    }

    void playRemoteUrl(const QUrl& url) override {
        playNativeUrl(url, {}, {});
    }

    void playHeaderedRemoteUrl(
        const QUrl& url,
        const QList<QPair<QByteArray, QByteArray>>& headers,
        const QString& mimeType) override {
        playNativeUrl(url, headers, mimeType);
    }

    void playStreamDevice(std::unique_ptr<QIODevice> device, const QString& mimeType) override {
        stopNativePlayback(false);
        if (fallback_) {
            fallback_->playStreamDevice(std::move(device), mimeType);
            return;
        }
        Q_UNUSED(device);
        Q_UNUSED(mimeType);
        emitError(QStringLiteral("Online stream playback unsupported on this platform."));
    }

    void pause() override {
        if (nativePlaybackActive_) {
            QJniObject::callStaticMethod<void>(
                nativePlayerClass,
                "pause",
                "(J)V",
                static_cast<jlong>(nativePlaybackId_));
            return;
        }
        if (fallback_) {
            fallback_->pause();
        }
    }

    void resume() override {
        if (nativePlaybackActive_) {
            QJniObject::callStaticMethod<void>(
                nativePlayerClass,
                "resume",
                "(J)V",
                static_cast<jlong>(nativePlaybackId_));
            return;
        }
        if (fallback_) {
            fallback_->resume();
        }
    }

    void stop() override {
        if (nativePlaybackActive_) {
            stopNativePlayback(true);
            return;
        }
        if (fallback_) {
            fallback_->stop();
        }
    }

    void seek(qint64 positionMs) override {
        if (nativePlaybackActive_) {
            QJniObject::callStaticMethod<void>(
                nativePlayerClass,
                "seek",
                "(JJ)V",
                static_cast<jlong>(nativePlaybackId_),
                static_cast<jlong>(positionMs));
            return;
        }
        if (fallback_) {
            fallback_->seek(positionMs);
        }
    }

    void setStateChangedCallback(StateChangedCallback callback) override {
        stateChangedCallback_ = std::move(callback);
    }

    void setErrorCallback(ErrorCallback callback) override {
        errorCallback_ = std::move(callback);
    }

    void handleNativeState(qint64 playbackId, QString state, std::optional<qint64> positionMs, std::optional<qint64> durationMs) {
        if (playbackId != nativePlaybackId_) {
            return;
        }
        if (state == QStringLiteral("stopped")) {
            nativePlaybackActive_ = false;
        }
        emitState(std::move(state), positionMs, durationMs);
    }

    void handleNativeError(qint64 playbackId, const QString& message) {
        if (playbackId != nativePlaybackId_) {
            return;
        }
        nativePlaybackActive_ = false;
        emitError(message.isEmpty() ? QStringLiteral("Playback failed") : message);
    }

    static AndroidNativePlaybackBackend* current() {
        QMutexLocker locker(&activeBackendMutex);
        return activeBackend;
    }

private:
    static void setActiveBackend(AndroidNativePlaybackBackend* backend) {
        QMutexLocker locker(&activeBackendMutex);
        activeBackend = backend;
    }

    static void clearActiveBackend(AndroidNativePlaybackBackend* backend) {
        QMutexLocker locker(&activeBackendMutex);
        if (activeBackend == backend) {
            activeBackend = nullptr;
        }
    }

    static QJniObject javaHeaders(const QList<QPair<QByteArray, QByteArray>>& headers) {
        QJniObject map("java/util/HashMap", "()V");
        for (const auto& header : headers) {
            const QJniObject key = QJniObject::fromString(QString::fromUtf8(header.first));
            const QJniObject value = QJniObject::fromString(QString::fromUtf8(header.second));
            map.callObjectMethod(
                "put",
                "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;",
                key.object<jobject>(),
                value.object<jobject>());
        }
        return map;
    }

    void playNativeUrl(
        const QUrl& url,
        const QList<QPair<QByteArray, QByteArray>>& headers,
        const QString& mimeType) {
        Q_UNUSED(mimeType);
        if (!url.isValid() || url.isEmpty()) {
            emitError(QStringLiteral("Playback URL is empty"));
            return;
        }

        nativePlaybackActive_ = true;
        nativePlaybackId_ = ++nextNativePlaybackId_;
        emitState(QStringLiteral("loading"), 0, std::nullopt);

        const QJniObject jUrl = QJniObject::fromString(url.toString());
        QJniObject jHeaders = javaHeaders(headers);
        QJniObject::callStaticMethod<void>(
            nativePlayerClass,
            "play",
            "(JLjava/lang/String;Ljava/util/HashMap;)V",
            static_cast<jlong>(nativePlaybackId_),
            jUrl.object<jstring>(),
            jHeaders.object<jobject>());
    }

    void stopNativePlayback(bool emitStopped) {
        if (nativePlaybackId_ <= 0) {
            return;
        }

        const qint64 playbackId = nativePlaybackId_;
        const bool wasActive = nativePlaybackActive_;
        nativePlaybackActive_ = false;
        if (!emitStopped) {
            nativePlaybackId_ = 0;
        }
        QJniObject::callStaticMethod<void>(
            nativePlayerClass,
            "stop",
            "(J)V",
            static_cast<jlong>(playbackId));
        if (emitStopped && wasActive) {
            emitState(QStringLiteral("stopped"), 0, std::nullopt);
        }
    }

    void emitState(QString state, std::optional<qint64> positionMs = std::nullopt, std::optional<qint64> durationMs = std::nullopt) {
        if (stateChangedCallback_) {
            stateChangedCallback_(PlaybackBackendState{
                .state = std::move(state),
                .positionMs = positionMs,
                .durationMs = durationMs,
            });
        }
    }

    void emitError(const QString& message) {
        if (errorCallback_) {
            errorCallback_(message);
        }
    }

    inline static AndroidNativePlaybackBackend* activeBackend = nullptr;
    inline static QMutex activeBackendMutex;

    std::unique_ptr<PlaybackBackend> fallback_;
    StateChangedCallback stateChangedCallback_;
    ErrorCallback errorCallback_;
    qint64 nextNativePlaybackId_ = 0;
    qint64 nativePlaybackId_ = 0;
    bool nativePlaybackActive_ = false;
};

AndroidNativePlaybackBackend* currentBackend() {
    return AndroidNativePlaybackBackend::current();
}

QString toQString(JNIEnv* env, jstring value) {
    if (value == nullptr) {
        return {};
    }

    const char* chars = env->GetStringUTFChars(value, nullptr);
    if (chars == nullptr) {
        return {};
    }

    const QString text = QString::fromUtf8(chars);
    env->ReleaseStringUTFChars(value, chars);
    return text;
}

std::optional<qint64> optionalPosition(jlong value) {
    if (value < 0) {
        return std::nullopt;
    }
    return static_cast<qint64>(value);
}

} // namespace

extern "C" JNIEXPORT void JNICALL Java_com_Vehicoule_auqw_AuqwNativeAudioPlayer_nativeOnPlaybackState(
    JNIEnv* env,
    jclass,
    jlong playbackId,
    jstring state,
    jlong positionMs,
    jlong durationMs) {
    AndroidNativePlaybackBackend* backend = currentBackend();
    if (backend == nullptr) {
        return;
    }

    const QString stateText = toQString(env, state);
    QMetaObject::invokeMethod(
        backend,
        [backend, playbackId, stateText, positionMs, durationMs] {
            backend->handleNativeState(
                static_cast<qint64>(playbackId),
                stateText,
                optionalPosition(positionMs),
                optionalPosition(durationMs));
        },
        Qt::QueuedConnection);
}

extern "C" JNIEXPORT void JNICALL Java_com_Vehicoule_auqw_AuqwNativeAudioPlayer_nativeOnPlaybackError(
    JNIEnv* env,
    jclass,
    jlong playbackId,
    jstring message) {
    AndroidNativePlaybackBackend* backend = currentBackend();
    if (backend == nullptr) {
        return;
    }

    const QString messageText = toQString(env, message);
    QMetaObject::invokeMethod(
        backend,
        [backend, playbackId, messageText] {
            backend->handleNativeError(static_cast<qint64>(playbackId), messageText);
        },
        Qt::QueuedConnection);
}

std::unique_ptr<PlaybackBackend> createAndroidNativePlaybackBackend(std::unique_ptr<PlaybackBackend> fallback) {
    return std::make_unique<AndroidNativePlaybackBackend>(std::move(fallback));
}

#endif
