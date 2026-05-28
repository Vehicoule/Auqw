param(
    [ValidateSet("windows")]
    [string]$Target = "windows"
)

$ErrorActionPreference = "Stop"

$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
$Image = "auqw-$Target`:dev"
$Containerfile = Join-Path $Root "containers\$Target\Containerfile"

docker build -t $Image -f $Containerfile $Root
docker run --rm -v "${Root}:C:\workspace" -w C:\workspace $Image

