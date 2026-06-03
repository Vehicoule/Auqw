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

function Get-MsvcRuntimeSearchDirs {
    $dirs = @()
    $redistRoots = @()

    if (-not [string]::IsNullOrWhiteSpace($env:VCToolsRedistDir)) {
        $redistRoots += $env:VCToolsRedistDir
    }
    if (-not [string]::IsNullOrWhiteSpace($env:VCINSTALLDIR)) {
        $redistRoots += Join-Path $env:VCINSTALLDIR "Redist\MSVC"
    }

    foreach ($root in $redistRoots | Where-Object { $_ } | Select-Object -Unique) {
        if (Test-Path $root) {
            $dirs += Get-ChildItem -Path $root -Directory -Recurse -Filter "Microsoft.VC*.CRT" -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match "\\x64\\" } |
                ForEach-Object { $_.FullName }
        }
    }

    $systemDir = Join-Path $env:WINDIR "System32"
    if (Test-Path $systemDir) {
        $dirs += $systemDir
    }

    $dirs | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique
}

function Copy-MsvcRuntimeDlls {
    param([Parameter(Mandatory = $true)][string]$PackageDir)

    $runtimeDirs = @(Get-MsvcRuntimeSearchDirs)
    $requiredRuntimeDlls = @(
        "vcruntime140.dll",
        "vcruntime140_1.dll",
        "msvcp140.dll"
    )

    foreach ($dll in $requiredRuntimeDlls) {
        $source = $runtimeDirs |
            ForEach-Object { Join-Path $_ $dll } |
            Where-Object { Test-Path $_ } |
            Select-Object -First 1
        if (-not $source) {
            throw "missing Windows MSVC runtime DLL source: $dll"
        }
        Copy-Item $source (Join-Path $PackageDir $dll) -Force
    }

    foreach ($dir in $runtimeDirs) {
        Get-ChildItem -Path $dir -Filter "msvcp140_*.dll" -File -ErrorAction SilentlyContinue |
            ForEach-Object { Copy-Item $_.FullName (Join-Path $PackageDir $_.Name) -Force }
    }
}

function Copy-VcRedistInstaller {
    param([Parameter(Mandatory = $true)][string]$PackageDir)

    $redistRoots = @()
    if (-not [string]::IsNullOrWhiteSpace($env:VCToolsRedistDir)) {
        $redistRoots += $env:VCToolsRedistDir
    }
    if (-not [string]::IsNullOrWhiteSpace($env:VCINSTALLDIR)) {
        $redistRoots += Join-Path $env:VCINSTALLDIR "Redist\MSVC"
    }

    $installer = $null
    foreach ($root in $redistRoots | Where-Object { $_ } | Select-Object -Unique) {
        if (-not (Test-Path $root)) {
            continue
        }
        $installer = Get-ChildItem -Path $root -File -Recurse -Include "vc_redist.x64.exe", "vcredist_x64.exe" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($installer) {
            break
        }
    }

    if ($installer) {
        Copy-Item $installer.FullName (Join-Path $PackageDir "vc_redist.x64.exe") -Force
    } else {
        Write-Warning "vc_redist.x64.exe not found in Visual Studio redist directories; MSVC runtime DLLs were bundled directly"
    }
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
        "Qt6Multimedia.dll",
        "vcruntime140.dll",
        "vcruntime140_1.dll",
        "msvcp140.dll"
    )) {
        Require-Path (Join-Path $PackageDir $dll) "Windows package runtime DLL"
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

function Write-WindowsSmokeLog {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Label
    )

    if (Test-Path $Path) {
        Write-Host "=== auqw.exe package smoke ${Label} ==="
        Get-Content $Path -ErrorAction SilentlyContinue | Select-Object -Last 120
    }
}

function Invoke-WindowsPackageSmoke {
    param([Parameter(Mandatory = $true)][string]$Exe)

    $packageDir = Split-Path $Exe -Parent
    $stdoutPath = Join-Path $packageDir "auqw-package-smoke.stdout.log"
    $stderrPath = Join-Path $packageDir "auqw-package-smoke.stderr.log"
    Remove-Item $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $Exe
    $startInfo.WorkingDirectory = $packageDir
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables["QT_QUICK_BACKEND"] = "software"
    $startInfo.EnvironmentVariables["QT_QUICK_CONTROLS_STYLE"] = "Basic"
    $startInfo.EnvironmentVariables["QSG_RHI_BACKEND"] = "software"
    $startInfo.EnvironmentVariables["QT_OPENGL"] = "software"
    $startInfo.EnvironmentVariables["QT_FORCE_STDERR_LOGGING"] = "1"
    $startInfo.EnvironmentVariables["QT_LOGGING_RULES"] = "qt.qml.warning=true;qt.quick.warning=true"

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $exited = $false
    try {
        [void]$process.Start()
        $exited = $process.WaitForExit(5000)
        if ($exited) {
            $stdout = $process.StandardOutput.ReadToEnd()
            $stderr = $process.StandardError.ReadToEnd()
            Set-Content -Path $stdoutPath -Value $stdout -NoNewline
            Set-Content -Path $stderrPath -Value $stderr -NoNewline
            if ($process.ExitCode -ne 0) {
                Write-WindowsSmokeLog $stdoutPath "stdout"
                Write-WindowsSmokeLog $stderrPath "stderr"
                throw "Windows package smoke failed: auqw.exe exited early with code $($process.ExitCode)"
            }
        }
    } finally {
        if (-not $exited -and -not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit()
        }
        $process.Dispose()
    }
}

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Core = Join-Path $Root "auqw-core"
$Build = if ($env:AUQW_BUILD_DIR) { $env:AUQW_BUILD_DIR } else { Join-Path $Root "build\windows" }
$Zig = if ($env:ZIG) { $env:ZIG } else { "zig" }
$ZigTarget = if ($env:AUQW_ZIG_TARGET) { $env:AUQW_ZIG_TARGET } else { "x86_64-windows-msvc" }
$ZigCache = if ($env:AUQW_ZIG_CACHE_DIR) { $env:AUQW_ZIG_CACHE_DIR } else { Join-Path $env:TEMP "auqw-zig-cache" }
$ZigGlobalCache = if ($env:AUQW_ZIG_GLOBAL_CACHE_DIR) { $env:AUQW_ZIG_GLOBAL_CACHE_DIR } else { Join-Path $env:TEMP "auqw-zig-global-cache" }
$CoreLib = Join-Path $Core "zig-out\lib\auqw_core.lib"
$ZigArgs = @(
    "--cache-dir", "$ZigCache",
    "--global-cache-dir", "$ZigGlobalCache",
    "-Dtarget=$ZigTarget"
)

Push-Location $Core
& $Zig build @ZigArgs test
& $Zig build @ZigArgs
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
Require-Path (Join-Path $QtPrefix "qml\QtQuick\Effects") "QtQuick\Effects QML runtime"
$WinDeployQt = Find-WinDeployQt $QtPrefix
if (-not $WinDeployQt) {
    throw "missing Windows dependency: windeployqt (set WINDEPLOYQT or add Qt bin to PATH)"
}

$CMakeArgs = @(
    "-S", $Root,
    "-B", $Build,
    "-G", "Ninja",
    "-DCMAKE_BUILD_TYPE=Release",
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
Copy-MsvcRuntimeDlls $PackageDir
Copy-VcRedistInstaller $PackageDir
Require-WindowsPackage $PackageDir
Invoke-WindowsPackageSmoke $Exe
$env:AUQW_WINDOWS_PACKAGE_DIR = $PackageDir
ctest --test-dir $Build --output-on-failure
