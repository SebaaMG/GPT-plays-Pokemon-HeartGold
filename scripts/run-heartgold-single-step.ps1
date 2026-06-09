param(
  [int]$BridgePort = 8010,
  [int]$NodePort = 9885,
  [int]$FrontendPort = 5173,
  [string]$Model = "gpt-5.5",
  [string]$ReasoningEffort = "xhigh",
  [switch]$NoBootstrap
)

$ErrorActionPreference = "Stop"

$env:AGENT_MAX_STEPS = "1"
$env:CODEX_REASONING_EFFORT = $ReasoningEffort

$startArgs = @(
  "-BridgePort", $BridgePort,
  "-NodePort", $NodePort,
  "-FrontendPort", $FrontendPort,
  "-Model", $Model,
  "-AgentProvider", "codex-cli"
)
if ($NoBootstrap) { $startArgs += "-NoBootstrap" }

& (Join-Path $PSScriptRoot "start-heartgold-benchmark.ps1") @startArgs

Write-Host "Single-step HeartGold run launched. Watch server logs until AGENT_MAX_STEPS=1 is reached."
