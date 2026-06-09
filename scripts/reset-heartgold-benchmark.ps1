param(
  [switch]$KeepSaves
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runtime = Join-Path $Root ".heartgold_runtime"
$ServerState = Join-Path $Root "server\gpt_data_heartgold"

powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "stop-heartgold-benchmark.ps1")

function Remove-WithinRoot {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  $resolvedRoot = [System.IO.Path]::GetFullPath($Root)
  $resolvedPath = [System.IO.Path]::GetFullPath((Resolve-Path $Path).Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside workspace: $resolvedPath"
  }
  Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

Remove-WithinRoot $ServerState
Remove-WithinRoot (Join-Path $Runtime "ipc")
Remove-WithinRoot (Join-Path $Runtime "logs")
Remove-WithinRoot (Join-Path $Runtime "screenshots")

if (-not $KeepSaves) {
  Remove-WithinRoot (Join-Path $Runtime "saves")
}

Write-Host "HeartGold generated benchmark state reset."
