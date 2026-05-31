$ErrorActionPreference = "Stop"

function Require-Path {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Description
    )

    if (-not (Test-Path $Path)) {
        throw "missing ${Description}: $Path"
    }
}

function Get-PathList {
    param([string]$Value)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return @()
    }
    return $Value.Split([char[]]@([IO.Path]::PathSeparator), [System.StringSplitOptions]::RemoveEmptyEntries)
}

function Get-QtCandidatePrefixes {
    $prefixes = @()
    $prefixes += Get-PathList $env:CMAKE_PREFIX_PATH
    if (-not [string]::IsNullOrWhiteSpace($env:QT_HOST_PATH)) {
        $prefixes += $env:QT_HOST_PATH
    }
    if (-not [string]::IsNullOrWhiteSpace($env:Qt6_DIR)) {
        $prefixes += (Resolve-Path (Join-Path $env:Qt6_DIR "..\..\..") -ErrorAction SilentlyContinue)
    }
    $qmake = Get-Command qmake6 -ErrorAction SilentlyContinue
    if ($qmake) {
        $prefix = & $qmake.Source -query QT_INSTALL_PREFIX
        if (-not [string]::IsNullOrWhiteSpace($prefix)) {
            $prefixes += $prefix
        }
    }
    $prefixes | Where-Object { $_ } | Select-Object -Unique
}

function Find-QtPackageConfig {
    param([Parameter(Mandatory = $true)][string]$Package)

    $envName = "${Package}_DIR"
    $envValue = [Environment]::GetEnvironmentVariable($envName)
    if (-not [string]::IsNullOrWhiteSpace($envValue)) {
        $candidate = Join-Path $envValue "${Package}Config.cmake"
        if (Test-Path $candidate) {
            return $candidate
        }
    }

    foreach ($prefix in Get-QtCandidatePrefixes) {
        $candidate = Join-Path $prefix "lib\cmake\$Package\${Package}Config.cmake"
        if (Test-Path $candidate) {
            return $candidate
        }
    }
    return $null
}

function Find-WinDeployQt {
    param([Parameter(Mandatory = $true)][string]$QtPrefix)

    if (-not [string]::IsNullOrWhiteSpace($env:WINDEPLOYQT)) {
        return $env:WINDEPLOYQT
    }
    $command = Get-Command windeployqt -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    $candidate = Join-Path $QtPrefix "bin\windeployqt.exe"
    if (Test-Path $candidate) {
        return $candidate
    }
    return $null
}

function Require-WindowsPackage {
    param([Parameter(Mandatory = $true)][string]$PackageDir)

    $exe = Join-Path $PackageDir "auqw.exe"
    Require-Path $exe "Windows package executable"

    foreach ($dll in @(
        "Qt6Core.dll",
        "Qt6Network.dll",
        "Qt6Qml.dll",
        "Qt6Quick.dll",
        "Qt6QuickControls2.dll",
        "Qt6Multimedia.dll"
    )) {
        Require-Path (Join-Path $PackageDir $dll) "Windows Qt runtime DLL"
    }

    $multimediaPluginDirs = @(
        (Join-Path $PackageDir "multimedia"),
        (Join-Path $PackageDir "plugins\multimedia")
    )
    $hasMultimediaBackend = $false
    foreach ($pluginDir in $multimediaPluginDirs) {
        if ((Test-Path $pluginDir) -and (Get-ChildItem $pluginDir -Filter "*.dll" -ErrorAction SilentlyContinue)) {
            $hasMultimediaBackend = $true
            break
        }
    }
    if (-not $hasMultimediaBackend) {
        throw "missing Windows Qt Multimedia backend plugin under multimedia or plugins\multimedia"
    }
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Core = Join-Path $Root "auqw-core"
$Build = if ($env:AUQW_BUILD_DIR) { $env:AUQW_BUILD_DIR } else { Join-Path $Root "build\windows" }
$Zig = if ($env:ZIG) { $env:ZIG } else { "zig" }
$ZigCache = if ($env:AUQW_ZIG_CACHE_DIR) { $env:AUQW_ZIG_CACHE_DIR } else { Join-Path $env:TEMP "auqw-zig-cache" }
$ZigGlobalCache = if ($env:AUQW_ZIG_GLOBAL_CACHE_DIR) { $env:AUQW_ZIG_GLOBAL_CACHE_DIR } else { Join-Path $env:TEMP "auqw-zig-global-cache" }
$CoreLib = Join-Path $Core "zig-out\lib\auqw_core.lib"

Push-Location $Core
& $Zig build --cache-dir "$ZigCache" --global-cache-dir "$ZigGlobalCache" test
& $Zig build --cache-dir "$ZigCache" --global-cache-dir "$ZigGlobalCache"
Pop-Location

Require-Path $CoreLib "Windows core artifact"

$Qt6Config = Find-QtPackageConfig "Qt6"
if (-not $Qt6Config) {
    throw "missing Windows dependency: Qt6Config.cmake (set CMAKE_PREFIX_PATH to the Qt kit)"
}
$Qt6MultimediaConfig = Find-QtPackageConfig "Qt6Multimedia"
if (-not $Qt6MultimediaConfig) {
    throw "missing Windows dependency: Qt6MultimediaConfig.cmake (install Qt Multimedia or update CMAKE_PREFIX_PATH)"
}
$QtPrefix = (Resolve-Path (Join-Path (Split-Path $Qt6Config -Parent) "..\..\..")).Path
$WinDeployQt = Find-WinDeployQt $QtPrefix
if (-not $WinDeployQt) {
    throw "missing Windows dependency: windeployqt (set WINDEPLOYQT or add Qt bin to PATH)"
}

$CMakeArgs = @(
    "-S", $Root,
    "-B", $Build,
    "-G", "Ninja",
    "-DAUQW_BUILD_QT=ON",
    "-DAUQW_REQUIRE_QT_MULTIMEDIA=ON",
    "-DAUQW_CORE_LIB=$CoreLib"
)
if ($env:CMAKE_PREFIX_PATH) {
    $CMakeArgs += "-DCMAKE_PREFIX_PATH=$env:CMAKE_PREFIX_PATH"
} else {
    $CMakeArgs += "-DCMAKE_PREFIX_PATH=$QtPrefix"
}

cmake @CMakeArgs
cmake --build $Build

$Exe = Join-Path $Build "bin\auqw.exe"
Require-Path $Exe "Windows built executable"
& $WinDeployQt --qmldir (Join-Path $Root "auqw-qt\qml") $Exe

$PackageDir = Split-Path $Exe -Parent
Require-WindowsPackage $PackageDir
$env:AUQW_WINDOWS_PACKAGE_DIR = $PackageDir
ctest --test-dir $Build --output-on-failure
