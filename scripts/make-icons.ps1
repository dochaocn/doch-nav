$dir = Join-Path $PSScriptRoot "..\icons" | Resolve-Path -ErrorAction SilentlyContinue
if (-not $dir) {
  $dir = Join-Path (Split-Path $PSScriptRoot -Parent) "icons"
}
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwADhwH/R2d0WQAAAABJRU5ErkJggg=="
$bytes = [Convert]::FromBase64String($b64)
[IO.File]::WriteAllBytes((Join-Path $dir "icon-16.png"), $bytes)
[IO.File]::WriteAllBytes((Join-Path $dir "icon-48.png"), $bytes)
[IO.File]::WriteAllBytes((Join-Path $dir "icon-128.png"), $bytes)
Write-Host "icons at $dir"
