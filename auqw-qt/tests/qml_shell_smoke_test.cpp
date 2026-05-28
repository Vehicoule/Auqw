#include "../src/CoreController.hpp"

#include <QDir>
#include <QFile>
#include <QGuiApplication>
#include <QMetaObject>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickItem>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>
#include <QUrl>

namespace {

bool writeTestFile(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::WriteOnly)) {
        return false;
    }
    return file.write("test") == 4;
}

QObject* findObjectByName(QObject* root, const QString& name) {
    if (root == nullptr) {
        return nullptr;
    }
    if (root->objectName() == name) {
        return root;
    }
    for (QObject* child : root->children()) {
        if (QObject* match = findObjectByName(child, name)) {
            return match;
        }
    }
    if (auto* item = qobject_cast<QQuickItem*>(root)) {
        for (QQuickItem* child : item->childItems()) {
            if (QObject* match = findObjectByName(child, name)) {
                return match;
            }
        }
    }
    return nullptr;
}

} // namespace

class QmlShellSmokeTest final : public QObject {
    Q_OBJECT

private slots:
    void loadsMainShell() {
        QTemporaryDir library;
        QVERIFY(library.isValid());
        QVERIFY(writeTestFile(QDir(library.path()).filePath(QStringLiteral("alpha.mp3"))));

        CoreController controller;
        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));

        QQmlApplicationEngine engine;
        engine.rootContext()->setContextProperty(QStringLiteral("coreController"), &controller);

        QSignalSpy creationFailures(&engine, &QQmlApplicationEngine::objectCreationFailed);
        engine.load(QUrl::fromLocalFile(QStringLiteral(AUQW_QML_SOURCE_DIR "/Main.qml")));

        QVERIFY2(creationFailures.isEmpty(), "Main.qml failed to load");
        QCOMPARE(engine.rootObjects().size(), 1);

        QObject* root = engine.rootObjects().first();
        QCOMPARE(root->objectName(), QStringLiteral("auqwShellWindow"));
        QVERIFY(root->findChild<QObject*>(QStringLiteral("mainStack")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("desktopNavigationRail")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("queuePanel")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("queueList")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("queueClearButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("importFolderButton")) != nullptr);
        QVERIFY(root->findChild<QObject*>(QStringLiteral("importStatusLabel")) != nullptr);

        QObject* libraryTrackDelegate = nullptr;
        QTRY_VERIFY((libraryTrackDelegate = findObjectByName(root, QStringLiteral("libraryTrackDelegate"))) != nullptr);
        QVERIFY(libraryTrackDelegate->property("enabled").toBool());
    }
};

int main(int argc, char** argv) {
    qputenv("QT_QPA_PLATFORM", "offscreen");

    QTemporaryDir dataHome;
    QTemporaryDir cacheHome;
    if (!dataHome.isValid() || !cacheHome.isValid()) {
        return 1;
    }

    qputenv("XDG_DATA_HOME", dataHome.path().toUtf8());
    qputenv("XDG_CACHE_HOME", cacheHome.path().toUtf8());

    QGuiApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("Auqw"));
    QCoreApplication::setOrganizationName(QStringLiteral("Vehicoule"));
    QCoreApplication::setOrganizationDomain(QStringLiteral("com.Vehicoule.auqw"));

    QmlShellSmokeTest test;
    return QTest::qExec(&test, argc, argv);
}

#include "qml_shell_smoke_test.moc"
