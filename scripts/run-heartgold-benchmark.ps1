param(
  [int]$BridgePort = 8010,
  [int]$NodePort = 9885,
  [int]$FrontendPort = 5173,
  [string]$Model = "gpt-5.5",
  [string]$ReasoningEffort = "xhigh",
  [string]$ObservationMode = "ram_assisted",
  [switch]$NoBootstrap
)

$ErrorActionPreference = "Stop"

$env:CODEX_REASONING_EFFORT = $ReasoningEffort
$env:HEARTGOLD_OBSERVATION_MODE = $ObservationMode
$env:HEARTGOLD_EXPOSE_ORACLE = "false"
$env:HEARTGOLD_STATE_CONFIDENCE_REQUIRED = "true"

$startArgs = @(
  "-BridgePort", $BridgePort,
  "-NodePort", $NodePort,
  "-FrontendPort", $FrontendPort,
  "-Model", $Model
)
if ($NoBootstrap) { $startArgs += "-NoBootstrap" }

& (Join-Path $PSScriptRoot "start-heartgold-benchmark.ps1") @startArgs
