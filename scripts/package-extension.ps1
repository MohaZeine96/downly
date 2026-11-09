$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'extension'
$destinationDir = Join-Path $root 'dist'
$destination = Join-Path $destinationDir 'Downly-Browser-Extension-1.0.0.zip'

if (-not (Test-Path -LiteralPath (Join-Path $source 'manifest.json'))) {
  throw "Extension manifest not found in $source"
}

New-Item -ItemType Directory -Path $destinationDir -Force | Out-Null
if (Test-Path -LiteralPath $destination) {
  Remove-Item -LiteralPath $destination -Force
}

Compress-Archive -Path (Join-Path $source '*') -DestinationPath $destination -CompressionLevel Optimal
Write-Output "Created $destination"
