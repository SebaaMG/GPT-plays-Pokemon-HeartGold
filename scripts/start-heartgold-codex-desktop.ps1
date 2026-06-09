param(
  [int]$BridgePort = 8010,
  [int]$NodePort = 9885,
  [int]$FrontendPort = 5173,
  [int]$SpeedMode = 100,
  [string]$Model = "gpt-5.5",
  [string]$ReasoningEffort = "xhigh",
  [string]$RuntimeDir = "",
  [string]$DataDir = "",
  [int]$ModelImageScale = 3,
  [switch]$NoBootstrap,
  [switch]$NoDashboard,
  [switch]$KeepExistingEmulators,
  [switch]$ForceSharedEmulatorPath,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$env:CODEX_DESKTOP_REASONING_EFFORT = $ReasoningEffort
$env:HEARTGOLD_MODEL_IMAGE_SCALE = [string]([Math]::Max(1, [Math]::Min(4, $ModelImageScale)))
if (-not $env:HEARTGOLD_LOW_STALL_ACTIONS) { $env:HEARTGOLD_LOW_STALL_ACTIONS = "true" }
if (-not $env:HEARTGOLD_CODEX_DESKTOP_SKIP_PREACTION_REFRESH) { $env:HEARTGOLD_CODEX_DESKTOP_SKIP_PREACTION_REFRESH = "true" }
if (-not $env:HEARTGOLD_ACTION_SETTLE_FRAMES) { $env:HEARTGOLD_ACTION_SETTLE_FRAMES = "0" }
if (-not $env:HEARTGOLD_FULL_SNAPSHOT_TIMEOUT_S) { $env:HEARTGOLD_FULL_SNAPSHOT_TIMEOUT_S = "30" }
if (-not $env:PYTHON_REQUEST_TIMEOUT_MS) { $env:PYTHON_REQUEST_TIMEOUT_MS = "90000" }

$startArgs = @{
  BridgePort = $BridgePort
  NodePort = $NodePort
  FrontendPort = $FrontendPort
  SpeedMode = $SpeedMode
  Model = $Model
  ModelImageScale = $ModelImageScale
  AgentProvider = "codex-desktop"
}
if ($RuntimeDir) { $startArgs.RuntimeDir = $RuntimeDir }
if ($DataDir) { $startArgs.DataDir = $DataDir }
if ($NoBootstrap) { $startArgs.NoBootstrap = $true }
if ($NoDashboard) { $startArgs.NoDashboard = $true }
if ($KeepExistingEmulators) { $startArgs.KeepExistingEmulators = $true }
if ($ForceSharedEmulatorPath) { $startArgs.ForceSharedEmulatorPath = $true }
if ($Restart) { $startArgs.Restart = $true }

& (Join-Path $PSScriptRoot "start-heartgold-benchmark.ps1") @startArgs

Write-Host ""
Write-Host "Codex Desktop mode is ready."
if (-not $NoDashboard) {
  $runtimeName = if ($RuntimeDir) { $RuntimeDir } else { ".heartgold_runtime" }
  $runtimePath = if ([System.IO.Path]::IsPathRooted($runtimeName)) {
    $runtimeName
  } else {
    Join-Path (Split-Path $PSScriptRoot -Parent) $runtimeName
  }
  $dashboardUrlPath = Join-Path $runtimePath "dashboard_url.txt"
  if (Test-Path -LiteralPath $dashboardUrlPath) {
    $dashboardUrl = (Get-Content -LiteralPath $dashboardUrlPath -Raw).Trim()
    Write-Host "Dashboard: $dashboardUrl"
  } else {
    Write-Host "Dashboard: http://127.0.0.1:$NodePort/"
  }
}
Write-Host "Model observation endpoint: http://127.0.0.1:$NodePort/codexDesktop/observation"
Write-Host "Action submission endpoint: http://127.0.0.1:$NodePort/codexDesktop/action"
Write-Host "Model image scale: $env:HEARTGOLD_MODEL_IMAGE_SCALE"
Write-Host "The gameplay operator must use only the Codex Desktop observation surface and execute_action JSON, not shell/repo/runtime inspection."
