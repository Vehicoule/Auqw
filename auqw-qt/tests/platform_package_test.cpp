#include <QDir>
#include <QDirIterator>
#include <QFile>
#include <QFileInfo>
#include <QString>
#include <QStringList>
#include <QTest>

namespace {

QString projectSourcePath(QStringView relativePath) {
    return QStringLiteral(AUQW_PROJECT_SOURCE_DIR) + QLatin1Char('/') + relativePath;
}

QString readTextFile(const QString& path) {
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text)) {
        return {};
    }
    return QString::fromUtf8(file.readAll());
}

QStringList recursiveFileNames(const QString& rootPath) {
    QStringList files;
    QDirIterator it(rootPath, QDir::Files, QDirIterator::Subdirectories);
    while (it.hasNext()) {
        const QString path = it.next();
        files.append(QDir(rootPath).relativeFilePath(path).replace(QLatin1Char('\\'), QLatin1Char('/')));
    }
    return files;
}

bool hasFileEndingWith(const QStringList& files, const QString& suffix) {
    for (const QString& file : files) {
        if (file.endsWith(suffix, Qt::CaseInsensitive)) {
            return true;
        }
    }
    return false;
}

bool hasFileContaining(const QStringList& files, const QString& needle) {
    for (const QString& file : files) {
        if (file.contains(needle, Qt::CaseInsensitive)) {
            return true;
        }
    }
    return false;
}

QString packagePathFromEnv(const char* name) {
    return QString::fromLocal8Bit(qgetenv(name));
}

} // namespace

class PlatformPackageTest final : public QObject {
    Q_OBJECT

private slots:
    void windowsBuildRequiresCachesQtMultimediaAndDeployment() {
        const QString script = readTextFile(projectSourcePath(u"ci/windows-build.ps1"));
        QVERIFY2(!script.isEmpty(), "ci/windows-build.ps1 should be readable");

        QVERIFY2(script.contains(QStringLiteral("$env:ZIG")), "Windows build should honor ZIG override");
        QVERIFY2(script.contains(QStringLiteral("AUQW_BUILD_DIR")), "Windows build should honor AUQW_BUILD_DIR");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_CACHE_DIR")), "Windows build should honor AUQW_ZIG_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_GLOBAL_CACHE_DIR")), "Windows build should honor AUQW_ZIG_GLOBAL_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("--cache-dir")), "Windows Zig build should use explicit cache dir");
        QVERIFY2(script.contains(QStringLiteral("--global-cache-dir")), "Windows Zig build should use explicit global cache dir");
        QVERIFY2(script.contains(QStringLiteral("Qt6MultimediaConfig.cmake")), "Windows build should fail fast when Qt Multimedia is absent");
        QVERIFY2(script.contains(QStringLiteral("AUQW_REQUIRE_QT_MULTIMEDIA=ON")), "Windows CMake configure should require Qt Multimedia");
        QVERIFY2(script.contains(QStringLiteral("windeployqt")), "Windows build should deploy Qt runtime with windeployqt");
        QVERIFY2(script.contains(QStringLiteral("Qt6Multimedia.dll")), "Windows package validation should require Qt Multimedia DLL");
        QVERIFY2(script.contains(QStringLiteral("plugins\\multimedia")) || script.contains(QStringLiteral("plugins/multimedia")),
            "Windows package validation should require Qt Multimedia plugin directory");
        QVERIFY2(!script.contains(QStringLiteral("CMAKE_CXX_COMPILER")), "Windows Qt shell should keep native platform compiler");
    }

    void macosBuildRequiresCachesQtMultimediaAndDeployment() {
        const QString script = readTextFile(projectSourcePath(u"ci/macos-build.sh"));
        QVERIFY2(!script.isEmpty(), "ci/macos-build.sh should be readable");

        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_CACHE_DIR")), "macOS build should honor AUQW_ZIG_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_GLOBAL_CACHE_DIR")), "macOS build should honor AUQW_ZIG_GLOBAL_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("--cache-dir")), "macOS Zig build should use explicit cache dir");
        QVERIFY2(script.contains(QStringLiteral("--global-cache-dir")), "macOS Zig build should use explicit global cache dir");
        QVERIFY2(script.contains(QStringLiteral("Qt6MultimediaConfig.cmake")), "macOS build should fail fast when Qt Multimedia is absent");
        QVERIFY2(script.contains(QStringLiteral("AUQW_REQUIRE_QT_MULTIMEDIA=ON")), "macOS CMake configure should require Qt Multimedia");
        QVERIFY2(script.contains(QStringLiteral("macdeployqt")), "macOS build should deploy Qt runtime with macdeployqt");
        QVERIFY2(script.contains(QStringLiteral("otool -L")), "macOS package validation should inspect bundle linkage");
        QVERIFY2(script.contains(QStringLiteral("QtMultimedia.framework")), "macOS package validation should require Qt Multimedia framework");
        QVERIFY2(script.contains(QStringLiteral("PlugIns/multimedia")) || script.contains(QStringLiteral("plugins/multimedia")),
            "macOS package validation should require Qt Multimedia plugin directory");
        QVERIFY2(!script.contains(QStringLiteral("CMAKE_CXX_COMPILER")), "macOS Qt shell should keep native platform compiler");
    }

    void iosBuildChecksQtKitAppleLinkageAndBundleMetadata() {
        const QString script = readTextFile(projectSourcePath(u"ci/ios-build.sh"));
        QVERIFY2(!script.isEmpty(), "ci/ios-build.sh should be readable");

        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_CACHE_DIR")), "iOS build should honor AUQW_ZIG_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("AUQW_ZIG_GLOBAL_CACHE_DIR")), "iOS build should honor AUQW_ZIG_GLOBAL_CACHE_DIR");
        QVERIFY2(script.contains(QStringLiteral("--cache-dir")), "iOS Zig build should use explicit cache dir");
        QVERIFY2(script.contains(QStringLiteral("--global-cache-dir")), "iOS Zig build should use explicit global cache dir");
        QVERIFY2(script.contains(QStringLiteral("QT_IOS_PREFIX")) || script.contains(QStringLiteral("CMAKE_PREFIX_PATH")),
            "iOS build should discover or accept a Qt iOS kit");
        QVERIFY2(script.contains(QStringLiteral("QT_HOST_PATH")), "iOS build should accept Qt host tools path");
        QVERIFY2(script.contains(QStringLiteral("Qt6MultimediaConfig.cmake")), "iOS build should fail fast when Qt Multimedia is absent");
        QVERIFY2(script.contains(QStringLiteral("AUQW_REQUIRE_QT_MULTIMEDIA=ON")), "iOS CMake configure should require Qt Multimedia");
        QVERIFY2(script.contains(QStringLiteral("CMAKE_SYSTEM_NAME=iOS")), "iOS build should configure an iOS target");
        QVERIFY2(script.contains(QStringLiteral("AVFoundation")), "iOS validation should verify AVFoundation linkage");
        QVERIFY2(script.contains(QStringLiteral("MediaPlayer")), "iOS validation should verify MediaPlayer linkage");
        QVERIFY2(script.contains(QStringLiteral("Info.plist")), "iOS validation should verify bundle metadata");
        QVERIFY2(script.contains(QStringLiteral("ctest")), "iOS build should run source/package CTest where available");
    }

    void freebsdDocsAndRuntimeCheckMirrorSourceBuildFlow() {
        const QString docs = readTextFile(projectSourcePath(u"ci/platform-builds.md"));
        const QString runtimeCheck = readTextFile(projectSourcePath(u"ci/check-freebsd-runtime.sh"));

        QVERIFY2(!docs.isEmpty(), "ci/platform-builds.md should be readable");
        QVERIFY2(!runtimeCheck.isEmpty(), "ci/check-freebsd-runtime.sh should be readable");

        QVERIFY2(docs.contains(QStringLiteral("pkg install")), "FreeBSD docs should list native package dependencies");
        QVERIFY2(docs.contains(QStringLiteral("AUQW_REQUIRE_QT_MULTIMEDIA=ON")), "FreeBSD docs should require Qt Multimedia for platform playback builds");
        QVERIFY2(docs.contains(QStringLiteral("ci/check-freebsd-runtime.sh")), "FreeBSD docs should document runtime validation script");
        QVERIFY2(runtimeCheck.contains(QStringLiteral("ldd")), "FreeBSD runtime check should use native ldd");
        QVERIFY2(runtimeCheck.contains(QStringLiteral("libQt6Multimedia")), "FreeBSD runtime check should verify Qt Multimedia linkage when present");
        QVERIFY2(runtimeCheck.contains(QStringLiteral("plugins/multimedia")), "FreeBSD runtime check should verify Qt Multimedia backend plugin path");
    }

    void windowsPackageContainsExpectedRuntimeWhenPathProvided() {
        const QString packagePath = packagePathFromEnv("AUQW_WINDOWS_PACKAGE_DIR");
        if (packagePath.isEmpty()) {
            QSKIP("Set AUQW_WINDOWS_PACKAGE_DIR to verify deployed Windows package contents");
        }
        if (!QFileInfo::exists(packagePath)) {
            QSKIP(qPrintable(QStringLiteral("Windows package not found at %1").arg(packagePath)));
        }

        const QStringList files = recursiveFileNames(packagePath);
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("auqw.exe")), "Windows package should contain auqw.exe");
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("Qt6Core.dll")), "Windows package should contain Qt6Core.dll");
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("Qt6Multimedia.dll")), "Windows package should contain Qt6Multimedia.dll");
        QVERIFY2(hasFileContaining(files, QStringLiteral("plugins/multimedia/")) || hasFileContaining(files, QStringLiteral("multimedia/")),
            "Windows package should contain a Qt Multimedia backend plugin");
    }

    void macosBundleContainsExpectedRuntimeWhenPathProvided() {
        const QString appPath = packagePathFromEnv("AUQW_MACOS_APP_PATH");
        if (appPath.isEmpty()) {
            QSKIP("Set AUQW_MACOS_APP_PATH to verify deployed macOS bundle contents");
        }
        if (!QFileInfo::exists(appPath)) {
            QSKIP(qPrintable(QStringLiteral("macOS app bundle not found at %1").arg(appPath)));
        }

        const QStringList files = recursiveFileNames(appPath);
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("Contents/Info.plist")), "macOS bundle should contain Info.plist");
        QVERIFY2(hasFileContaining(files, QStringLiteral("Contents/Frameworks/QtMultimedia.framework")),
            "macOS bundle should contain Qt Multimedia framework");
        QVERIFY2(hasFileContaining(files, QStringLiteral("Contents/PlugIns/multimedia/")),
            "macOS bundle should contain a Qt Multimedia backend plugin");
    }

    void iosBundleContainsExpectedMetadataWhenPathProvided() {
        const QString appPath = packagePathFromEnv("AUQW_IOS_APP_PATH");
        if (appPath.isEmpty()) {
            QSKIP("Set AUQW_IOS_APP_PATH to verify built iOS bundle contents");
        }
        if (!QFileInfo::exists(appPath)) {
            QSKIP(qPrintable(QStringLiteral("iOS app bundle not found at %1").arg(appPath)));
        }

        const QStringList files = recursiveFileNames(appPath);
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("Info.plist")), "iOS bundle should contain Info.plist");
        QVERIFY2(hasFileEndingWith(files, QStringLiteral("auqw")), "iOS bundle should contain app binary");
        QVERIFY2(hasFileContaining(files, QStringLiteral("Frameworks")),
            "iOS bundle should contain deployed framework layout when Qt kit produced artifacts");
    }
};

QTEST_GUILESS_MAIN(PlatformPackageTest)

#include "platform_package_test.moc"
