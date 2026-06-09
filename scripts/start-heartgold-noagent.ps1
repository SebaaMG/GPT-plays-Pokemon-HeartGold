param(
  [int]$BridgePort = 8010,
  [int]$NodePort = 9885,
  [int]$FrontendPort = 5173,
  [switch]$NoBootstrap
)

$ErrorActionPreference = "Stop"

$args = @(
  "-ExecutionPolicy", "Bypass",
  "-File", (Join-Path $PSScriptRoot "start-heartgold-benchmark.ps1"),
  "-BridgePort", [string]$BridgePort,
  "-NodePort", [string]$NodePort,
  "-FrontendPort", [string]$FrontendPort,
  "-NoAgent"
)

if ($NoBootstrap) {
  $args += "-NoBootstrap"
}

powershell @args
