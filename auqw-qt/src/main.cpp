#include "CoreController.hpp"
#if AUQW_ENABLE_ANDROID_PLATFORM
#include "AndroidPlaybackController.hpp"
#endif
#if AUQW_ENABLE_IOS_PLATFORM
#include "IosPlaybackController.hpp"
#endif
#if AUQW_ENABLE_DESKTOP_PLATFORM
#include "DesktopPlatformController.hpp"
#endif

#if AUQW_ENABLE_DESKTOP_PLATFORM
#include <QApplication>
#else
#include <QCoreApplication>
#endif
#include <QDir>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQmlError>
#include <QUrl>
#include <QWindow>

#include <cstdio>

int main(int argc, char* argv[]) {
#if AUQW_ENABLE_DESKTOP_PLATFORM
    QApplication app(argc, argv);
#else
    QGuiApplication app(argc, argv);
#endif

    const QDir bundledPluginDir(QCoreApplication::applicationDirPath() + QStringLiteral("/../plugins"));
    if (bundledPluginDir.exists()) {
        QCoreApplication::addLibraryPath(bundledPluginDir.absolutePath());
    }

    QCoreApplication::setApplicationName(QStringLiteral("Auqw"));
    QCoreApplication::setApplicationVersion(QStringLiteral("0.0.1"));
    QCoreApplication::setOrganizationDomain(QStringLiteral("com.Vehicoule.auqw"));
    QCoreApplication::setOrganizationName(QStringLiteral("Vehicoule"));
#if defined(Q_OS_LINUX)
    QGuiApplication::setDesktopFileName(QStringLiteral("com.vehicoule.auqw"));
#endif

    CoreController coreController;
#if AUQW_ENABLE_ANDROID_PLATFORM
    AndroidPlaybackController androidPlaybackController(coreController);
#endif
#if AUQW_ENABLE_IOS_PLATFORM
    IosPlaybackController iosPlaybackController(coreController);
#endif
#if AUQW_ENABLE_DESKTOP_PLATFORM
    DesktopPlatformController desktopPlatformController(coreController);
#endif

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &coreController);

    QObject::connect(
        &engine,
        &QQmlApplicationEngine::warnings,
        [](const QList<QQmlError>& warnings) {
            for (const QQmlError& warning : warnings) {
                const QByteArray message = warning.toString().toLocal8Bit();
                std::fprintf(stderr, "QML warning: %s\n", message.constData());
            }
        });
    QObject::connect(
        &engine,
        &QQmlApplicationEngine::objectCreationFailed,
        &app,
        [] {
            std::fprintf(stderr, "QML object creation failed\n");
            QCoreApplication::exit(-1);
        },
        Qt::QueuedConnection);

#if QT_VERSION >= QT_VERSION_CHECK(6, 5, 0)
    engine.loadFromModule(QStringLiteral("Auqw"), QStringLiteral("Main"));
#else
    engine.load(QUrl(QStringLiteral("qrc:/Auqw/qml/Main.qml")));
#endif
#if AUQW_ENABLE_DESKTOP_PLATFORM
    if (!engine.rootObjects().isEmpty()) {
        desktopPlatformController.bindWindow(qobject_cast<QWindow*>(engine.rootObjects().first()));
    }
#endif

    return app.exec();
}
