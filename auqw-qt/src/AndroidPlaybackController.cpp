#include "AndroidPlaybackController.hpp"

#include "CoreController.hpp"

#include <QJniObject>
#include <QMetaObject>
#include <QMutex>
#include <QMutexLocker>
#include <QPointer>

#include <algorithm>
#include <jni.h>

namespace {

constexpr auto bridgeClass = "com/Vehicoule/auqw/AuqwMediaSessionBridge";

QMutex activeControllerMutex;
QPointer<AndroidPlaybackController> activeController;

void setActiveController(AndroidPlaybackController* controller) {
    QMutexLocker locker(&activeControllerMutex);
    activeController = controller;
}

void clearActiveController(AndroidPlaybackController* controller) {
    QMutexLocker locker(&activeControllerMutex);
    if (activeController == controller) {
        activeController.clear();
    }
}

AndroidPlaybackController* currentController() {
    QMutexLocker locker(&activeControllerMutex);
    return activeController.data();
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

extern "C" JNIEXPORT void JNICALL Java_com_Vehicoule_auqw_AuqwMediaSessionBridge_nativeDispatchPlaybackCommand(
    JNIEnv* env,
    jclass,
    jstring command,
    jlong positionMs) {
    AndroidPlaybackController* controller = currentController();
    if (controller == nullptr) {
        return;
    }

    const QString commandText = toQString(env, command);
    if (commandText.isEmpty()) {
        return;
    }

    QMetaObject::invokeMethod(
        controller,
        [controller, commandText, positionMs] {
            controller->handlePlaybackCommand(commandText, static_cast<qint64>(positionMs));
        },
        Qt::QueuedConnection);
}

AndroidPlaybackController::AndroidPlaybackController(CoreController& coreController, QObject* parent)
    : QObject(parent),
      coreController_(coreController) {
    setActiveController(this);
    connect(&coreController_, &CoreController::playbackStateChanged, this, &AndroidPlaybackController::syncPlaybackState);

    QJniObject::callStaticMethod<void>(bridgeClass, "ensureSession", "()V");
    syncPlaybackState();
}

AndroidPlaybackController::~AndroidPlaybackController() {
    clearActiveController(this);
    QJniObject::callStaticMethod<void>(bridgeClass, "shutdown", "()V");
}

void AndroidPlaybackController::handlePlaybackCommand(const QString& command, qint64 positionMs) {
    if (command == QStringLiteral("play")) {
        const QString state = coreController_.playbackState();
        if (state == QStringLiteral("paused")) {
            coreController_.resumePlayback();
        } else if (state != QStringLiteral("playing") && state != QStringLiteral("loading")) {
            coreController_.playFirstQueuedTrack();
        }
        return;
    }

    if (command == QStringLiteral("pause")) {
        coreController_.pausePlayback();
        return;
    }

    if (command == QStringLiteral("stop")) {
        coreController_.stopPlayback();
        return;
    }

    if (command == QStringLiteral("next")) {
        coreController_.playNextQueuedTrack();
        return;
    }

    if (command == QStringLiteral("previous")) {
        coreController_.playPreviousQueuedTrack();
        return;
    }

    if (command == QStringLiteral("seek")) {
        coreController_.seekPlayback(std::max<qint64>(0, positionMs));
    }
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
