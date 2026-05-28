#include "../src/CoreController.hpp"

#include <QAbstractItemModel>
#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QMetaObject>
#include <QObject>
#include <QSignalSpy>
#include <QStandardPaths>
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

int roleForName(const QAbstractItemModel* model, const QByteArray& name) {
    const QHash<int, QByteArray> roles = model->roleNames();
    for (auto it = roles.cbegin(); it != roles.cend(); ++it) {
        if (it.value() == name) {
            return it.key();
        }
    }
    return -1;
}

} // namespace

class CoreControllerTest final : public QObject {
    Q_OBJECT

private slots:
    void init() {
        QDir appData(QStandardPaths::writableLocation(QStandardPaths::AppDataLocation));
        if (appData.exists()) {
            QVERIFY(appData.removeRecursively());
        }
    }

    void exposesCoreMetadataAndEmptyModels() {
        CoreController controller;

        QCOMPARE(controller.property("appName").toString(), QStringLiteral("Auqw"));
        QCOMPARE(controller.property("appId").toString(), QStringLiteral("com.Vehicoule.auqw"));
        QVERIFY(controller.property("databasePath").toString().endsWith(QStringLiteral("auqw.sqlite3")));
        QCOMPARE(controller.property("schemaVersion").toInt(), 2);
        QCOMPARE(controller.property("coreStatus").toString(), QStringLiteral("Ready"));
        QCOMPARE(controller.property("helloText").toString(), QStringLiteral("Hello from Auqw Core"));

        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        auto* playlists = qobject_cast<QAbstractItemModel*>(controller.property("playlistsModel").value<QObject*>());
        auto* queue = qobject_cast<QAbstractItemModel*>(controller.property("queueModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(playlists != nullptr);
        QVERIFY(queue != nullptr);
        QCOMPARE(tracks->rowCount(), 0);
        QCOMPARE(playlists->rowCount(), 0);
        QCOMPARE(queue->rowCount(), 0);
    }

    void themeSettingRoundTripsThroughCore() {
        CoreController controller;
        QSignalSpy spy(&controller, SIGNAL(themeSettingChanged()));

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "setThemeSetting",
            Q_ARG(QString, QStringLiteral("dark"))));

        QCOMPARE(controller.property("themeSetting").toString(), QStringLiteral("dark"));
        QCOMPARE(spy.count(), 1);
        QCOMPARE(controller.property("coreStatus").toString(), QStringLiteral("Ready"));
    }

    void importsLocalFolderIntoLibraryModel() {
        QTemporaryDir library;
        QVERIFY(library.isValid());

        QDir dir(library.path());
        QVERIFY(dir.mkpath(QStringLiteral("nested")));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("alpha.mp3"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("nested/beta.flac"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("ignore.txt"))));

        CoreController controller;
        QSignalSpy statusSpy(&controller, SIGNAL(importStatusChanged()));
        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        QVERIFY(tracks != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));

        QCOMPARE(tracks->rowCount(), 2);
        QCOMPARE(controller.property("importedTrackCount").toInt(), 2);
        QCOMPARE(controller.property("importStatus").toString(), QStringLiteral("Imported 2 tracks"));
        QVERIFY(statusSpy.count() >= 1);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));

        QCOMPARE(tracks->rowCount(), 2);
        QCOMPARE(controller.property("importedTrackCount").toInt(), 2);
        QCOMPARE(controller.property("importStatus").toString(), QStringLiteral("Imported 2 tracks"));
    }

    void queuesImportedTracksThroughCore() {
        QTemporaryDir library;
        QVERIFY(library.isValid());

        QDir dir(library.path());
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("alpha.mp3"))));
        QVERIFY(writeTestFile(dir.filePath(QStringLiteral("beta.flac"))));

        CoreController controller;
        auto* tracks = qobject_cast<QAbstractItemModel*>(controller.property("tracksModel").value<QObject*>());
        auto* queue = qobject_cast<QAbstractItemModel*>(controller.property("queueModel").value<QObject*>());
        QVERIFY(tracks != nullptr);
        QVERIFY(queue != nullptr);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "importLocalFolder",
            Q_ARG(QUrl, QUrl::fromLocalFile(library.path()))));

        QCOMPARE(tracks->rowCount(), 2);
        QCOMPARE(queue->rowCount(), 0);

        const int trackIdRole = roleForName(tracks, "id");
        QVERIFY(trackIdRole > 0);
        const QString firstTrackId = tracks->data(tracks->index(0, 0), trackIdRole).toString();
        const QString secondTrackId = tracks->data(tracks->index(1, 0), trackIdRole).toString();
        QVERIFY(!firstTrackId.isEmpty());
        QVERIFY(!secondTrackId.isEmpty());

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "addTrackToQueue",
            Q_ARG(QString, firstTrackId)));
        QCOMPARE(queue->rowCount(), 1);

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "addTrackToQueue",
            Q_ARG(QString, secondTrackId)));
        QCOMPARE(queue->rowCount(), 2);

        const int queueIdRole = roleForName(queue, "id");
        const int queueTitleRole = roleForName(queue, "title");
        const int queueLocalPathRole = roleForName(queue, "local_path");
        QVERIFY(queueIdRole > 0);
        QVERIFY(queueTitleRole > 0);
        QVERIFY(queueLocalPathRole > 0);

        const QString firstQueueItemId = queue->data(queue->index(0, 0), queueIdRole).toString();
        QVERIFY(!firstQueueItemId.isEmpty());
        QCOMPARE(queue->data(queue->index(0, 0), queueTitleRole).toString(), QStringLiteral("alpha"));
        QVERIFY(queue->data(queue->index(0, 0), queueLocalPathRole).toString().endsWith(QStringLiteral("alpha.mp3")));

        QVERIFY(QMetaObject::invokeMethod(
            &controller,
            "removeQueueItem",
            Q_ARG(QString, firstQueueItemId)));
        QCOMPARE(queue->rowCount(), 1);
        QCOMPARE(queue->data(queue->index(0, 0), queueTitleRole).toString(), QStringLiteral("beta"));

        QVERIFY(QMetaObject::invokeMethod(&controller, "clearQueue"));
        QCOMPARE(queue->rowCount(), 0);
    }
};

int main(int argc, char** argv) {
    QTemporaryDir dataHome;
    QTemporaryDir cacheHome;
    if (!dataHome.isValid() || !cacheHome.isValid()) {
        return 1;
    }

    qputenv("XDG_DATA_HOME", dataHome.path().toUtf8());
    qputenv("XDG_CACHE_HOME", cacheHome.path().toUtf8());
    QCoreApplication app(argc, argv);
    QCoreApplication::setApplicationName(QStringLiteral("Auqw"));
    QCoreApplication::setOrganizationName(QStringLiteral("Vehicoule"));
    QCoreApplication::setOrganizationDomain(QStringLiteral("com.Vehicoule.auqw"));

    CoreControllerTest test;
    return QTest::qExec(&test, argc, argv);
}

#include "core_controller_test.moc"
