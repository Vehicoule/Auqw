$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Core = Join-Path $Root "auqw-core"
$Build = Join-Path $Root "build\windows"
$CoreLib = Join-Path $Core "zig-out\lib\auqw_core.lib"

Push-Location $Core
zig build test
zig build
Pop-Location

cmake -S $Root -B $Build -G Ninja -DAUQW_BUILD_QT=ON -DAUQW_CORE_LIB="$CoreLib"
cmake --build $Build
ctest --test-dir $Build --output-on-failure

