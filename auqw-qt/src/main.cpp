#include "CoreController.hpp"

#include <QCoreApplication>
#include <QGuiApplication>
#include <QQmlApplicationEngine>
#include <QQmlContext>

int main(int argc, char* argv[]) {
    QGuiApplication app(argc, argv);

    QCoreApplication::setApplicationName(QStringLiteral("Auqw"));
    QCoreApplication::setApplicationVersion(QStringLiteral("0.1.0"));
    QCoreApplication::setOrganizationDomain(QStringLiteral("com.Vehicoule.auqw"));
    QCoreApplication::setOrganizationName(QStringLiteral("Vehicoule"));

    CoreController coreController;

    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &coreController);

    QObject::connect(
        &engine,
        &QQmlApplicationEngine::objectCreationFailed,
        &app,
        [] {
            QCoreApplication::exit(-1);
        },
        Qt::QueuedConnection);

    engine.loadFromModule(QStringLiteral("Auqw"), QStringLiteral("Main"));

    return app.exec();
}

