#pragma once

#include <QCoreApplication>
#include <QStandardPaths>
#include <QString>
#include <QTemporaryDir>

namespace auqw::tests {

class TestStorage final {
public:
    explicit TestStorage(const QString& applicationName)
        : applicationName_(applicationName) {
        if (!isValid()) {
            return;
        }

        qputenv("HOME", home_.path().toUtf8());
        qputenv("XDG_DATA_HOME", dataHome_.path().toUtf8());
        qputenv("XDG_CACHE_HOME", cacheHome_.path().toUtf8());
        qputenv("XDG_CONFIG_HOME", configHome_.path().toUtf8());
        QStandardPaths::setTestModeEnabled(true);
    }

    bool isValid() const {
        return home_.isValid() && dataHome_.isValid() && cacheHome_.isValid()
            && configHome_.isValid();
    }

    void applyApplicationMetadata() const {
        QCoreApplication::setApplicationName(applicationName_);
        QCoreApplication::setOrganizationName(QStringLiteral("Vehicoule"));
        QCoreApplication::setOrganizationDomain(QStringLiteral("com.Vehicoule.auqw"));
    }

private:
    QTemporaryDir home_;
    QTemporaryDir dataHome_;
    QTemporaryDir cacheHome_;
    QTemporaryDir configHome_;
    QString applicationName_;
};

} // namespace auqw::tests
