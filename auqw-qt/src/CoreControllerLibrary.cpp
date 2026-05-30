#include "CoreController.hpp"
#include "JsonListModel.hpp"

#include <QDirIterator>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonObject>
#include <QJsonValue>
#include <QUrl>
#include <QVariantMap>

namespace {

QVector<QVariantMap> mapsFromArray(const QJsonArray& array) {
    QVector<QVariantMap> items;
    items.reserve(array.size());

    for (const QJsonValue& value : array) {
        if (value.isObject()) {
            items.push_back(value.toObject().toVariantMap());
        }
    }

    return items;
}

QVector<QVariantMap> mapsWithAliasFromArray(
    const QJsonArray& array,
    const QString& aliasRole,
    const QString& sourceRole) {
    QVector<QVariantMap> items = mapsFromArray(array);
    for (QVariantMap& item : items) {
        item.insert(aliasRole, item.value(sourceRole));
    }
    return items;
}

bool isSupportedAudioFile(const QFileInfo& fileInfo) {
    const QString suffix = fileInfo.suffix().toLower();
    return suffix == QStringLiteral("mp3")
        || suffix == QStringLiteral("flac")
        || suffix == QStringLiteral("wav")
        || suffix == QStringLiteral("m4a")
        || suffix == QStringLiteral("aac")
        || suffix == QStringLiteral("ogg")
        || suffix == QStringLiteral("opus")
        || suffix == QStringLiteral("aiff")
        || suffix == QStringLiteral("aif");
}

} // namespace

void CoreController::setThemeSetting(const QString& value) {
    const CommandResult result = invokeCommand(
        QStringLiteral("settings.set.theme"),
        QStringLiteral("settings.set"),
        QJsonObject{
            {QStringLiteral("key"), QStringLiteral("theme")},
            {QStringLiteral("value"), value},
        });

    if (!result.ok) {
        setCoreStatus(result.error);
        return;
    }

    const QJsonObject setting = result.data.value(QStringLiteral("setting")).toObject();
    setThemeSettingFromCore(setting.value(QStringLiteral("value")).toString());
    setCoreStatus(QStringLiteral("Ready"));
}

void CoreController::importLocalFolder(const QUrl& folderUrl) {
    const QString folderPath = folderUrl.toLocalFile();
    const QFileInfo folderInfo(folderPath);
    if (folderPath.isEmpty() || !folderInfo.exists() || !folderInfo.isDir()) {
        setImportResult(QStringLiteral("No audio files found"), 0);
        return;
    }

    int imported = 0;
    QDirIterator iterator(
        folderInfo.absoluteFilePath(),
        QDir::Files | QDir::NoDotAndDotDot | QDir::Readable,
        QDirIterator::Subdirectories);

    while (iterator.hasNext()) {
        const QFileInfo fileInfo(iterator.next());
        if (!isSupportedAudioFile(fileInfo)) {
            continue;
        }

        const QString title = fileInfo.completeBaseName();
        const CommandResult result = invokeCommand(
            QStringLiteral("local_files.upsert"),
            QStringLiteral("local_files.upsert"),
            QJsonObject{
                {QStringLiteral("path"), fileInfo.absoluteFilePath()},
                {QStringLiteral("title"), title},
            });

        if (!result.ok) {
            setImportResult(result.error, imported);
            refreshState();
            return;
        }

        ++imported;
    }

    refreshState();

    if (imported == 0) {
        setImportResult(QStringLiteral("No audio files found"), 0);
        return;
    }

    setImportResult(QStringLiteral("Imported %1 tracks").arg(imported), imported);
}

bool CoreController::refreshTracksFromCore() {
    const CommandResult tracks = invokeCommand(
        QStringLiteral("tracks.list"),
        QStringLiteral("tracks.list"));
    if (!tracks.ok) {
        setCoreStatus(tracks.error);
        return false;
    }

    tracksModel_->setItems(mapsWithAliasFromArray(
        tracks.data.value(QStringLiteral("tracks")).toArray(),
        QStringLiteral("track_id"),
        QStringLiteral("id")));
    return true;
}
