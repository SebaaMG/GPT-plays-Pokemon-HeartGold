param(
  [int]$BridgePort = 8010,
  [int]$NodePort = 9885,
  [int]$FrontendPort = 5173,
  [switch]$StartStack,
  [switch]$NoBootstrap,
  [switch]$SkipInput,
  [string]$ReportPath = ""
)

$ErrorActionPreference = "Continue"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runtime = Join-Path $Root ".heartgold_runtime"
$BridgeUrl = "http://127.0.0.1:$BridgePort"
$NodeUrl = "http://127.0.0.1:$NodePort"
$FrontendUrl = "http://127.0.0.1:$FrontendPort"
if (-not $ReportPath) { $ReportPath = Join-Path $Root "output\heartgold_smoke\SMOKE_TEST_REPORT.md" }
New-Item -ItemType Directory -Force -Path (Split-Path $ReportPath) | Out-Null

$results = New-Object System.Collections.Generic.List[object]

function Resolve-FrontendFromRuntime {
  $dashboardUrlFile = Join-Path $Runtime "dashboard_url.txt"
  $actualPortFile = Join-Path $Runtime "frontend_port.txt"

  if (Test-Path -LiteralPath $dashboardUrlFile) {
    $url = (Get-Content -LiteralPath $dashboardUrlFile -Raw).Trim()
    if ($url) {
      $script:FrontendUrl = $url
      if ($url -match ':(\d+)(?:/)?$') {
        $script:FrontendPort = [int]$matches[1]
      }
      return
    }
  }

  if (Test-Path -LiteralPath $actualPortFile) {
    $script:FrontendPort = [int](Get-Content -LiteralPath $actualPortFile -Raw)
    $script:FrontendUrl = "http://127.0.0.1:$script:FrontendPort"
  }
}

function Add-Result {
  param([string]$Name, [bool]$Ok, [string]$Details = "")
  $script:results.Add([pscustomobject]@{ name = $Name; ok = $Ok; details = $Details }) | Out-Null
}

function Try-Step {
  param([string]$Name, [scriptblock]$Body)
  try {
    $value = & $Body
    Add-Result $Name $true (($value | ConvertTo-Json -Depth 10 -Compress) -replace '\|','/')
    return $value
  } catch {
    Add-Result $Name $false $_.Exception.Message
    return $null
  }
}

function Assert-OkPayload {
  param([object]$Value, [string]$Label)
  if ($null -eq $Value) { throw "$Label returned null" }
  if ($Value.PSObject.Properties.Name -contains "ok" -and $Value.ok -eq $false) {
    throw "$Label returned ok=false: $($Value.error)"
  }
  if ($Value.PSObject.Properties.Name -contains "status" -and $Value.status -eq $false) {
    throw "$Label returned status=false: $($Value.message)"
  }
  return $Value
}

Push-Location $Root
try {
  Try-Step "Python py_compile" { python -m py_compile heartgold_benchmark\heartgold_bridge.py heartgold_benchmark\minimap.py heartgold_benchmark\rom_data.py; "ok" } | Out-Null
  Try-Step "Node syntax checks" {
    node --check server\index.js | Out-Null
    node --check server\src\core\gameLoop.js | Out-Null
    node --check server\src\ai\tools.js | Out-Null
    node --check server\src\services\codexCliService.js | Out-Null
    node --check server\src\services\codexDesktopService.js | Out-Null
    node --check server\src\services\pythonService.js | Out-Null
    node --check server\src\ai\promptBuilder.js | Out-Null
    "ok"
  } | Out-Null

  if ($StartStack) {
    Try-Step "Start no-agent stack" {
      $startArgs = @{
        BridgePort = $BridgePort
        NodePort = $NodePort
        FrontendPort = $FrontendPort
        NoAgent = $true
      }
      if ($NoBootstrap) { $startArgs.NoBootstrap = $true }
      & (Join-Path $PSScriptRoot "start-heartgold-benchmark.ps1") @startArgs
      Resolve-FrontendFromRuntime
      "started"
    } | Out-Null
    if ($NoBootstrap) {
      Add-Result "bootstrapIntro" $true "skipped_by_smoke_startup_no_bootstrap"
    } else {
      Add-Result "bootstrapIntro" $true "handled_by_start_stack"
    }
  }

  Resolve-FrontendFromRuntime

  $bridgeHealth = Try-Step "Bridge /health" { Assert-OkPayload (Invoke-RestMethod -Uri "$BridgeUrl/health" -TimeoutSec 5) "Bridge /health" }
  Try-Step "Bridge /requestData" { Assert-OkPayload (Invoke-RestMethod -Uri "$BridgeUrl/requestData" -TimeoutSec 20) "Bridge /requestData" } | Out-Null
  Try-Step "Screenshot raw exists/fresh" {
    $data = Assert-OkPayload (Invoke-RestMethod -Uri "$BridgeUrl/requestData" -TimeoutSec 20) "Bridge /requestData"
    $path = $data.data.screenshot_raw_path
    if (-not $path -or -not (Test-Path -LiteralPath $path)) { throw "missing screenshot: $path" }
    $ageMs = ((Get-Date) - (Get-Item -LiteralPath $path).LastWriteTime).TotalMilliseconds
    [pscustomobject]@{ path = $path; ageMs = [int]$ageMs; hash = $data.data.screenshotHash }
  } | Out-Null

  if (-not $SkipInput) {
    Try-Step "sendCommands press A" {
      Assert-OkPayload (Invoke-RestMethod -Method Post -Uri "$BridgeUrl/sendCommands" -ContentType "application/json" -Body '{"commands":[{"type":"press","buttons":["a"],"frames":8}]}' -TimeoutSec 30) "sendCommands press A"
    } | Out-Null
    Try-Step "sendCommands directional" {
      Assert-OkPayload (Invoke-RestMethod -Method Post -Uri "$BridgeUrl/sendCommands" -ContentType "application/json" -Body '{"commands":[{"type":"press","buttons":["right"],"frames":8}]}' -TimeoutSec 30) "sendCommands directional"
    } | Out-Null
    Try-Step "save/load roundtrip" {
      Assert-OkPayload (powershell -ExecutionPolicy Bypass -File scripts\test-heartgold-save-load.ps1 -BridgeUrl $BridgeUrl | ConvertFrom-Json) "save/load roundtrip"
    } | Out-Null
  }

  Try-Step "minimapSnapshot" { Assert-OkPayload (Invoke-RestMethod -Uri "$BridgeUrl/minimapSnapshot" -TimeoutSec 10) "minimapSnapshot" } | Out-Null
  Try-Step "Node /health" { Assert-OkPayload (Invoke-RestMethod -Uri "$NodeUrl/health" -TimeoutSec 5) "Node /health" } | Out-Null
  Try-Step "Node /gameState" { Assert-OkPayload (Invoke-RestMethod -Uri "$NodeUrl/gameState" -TimeoutSec 20) "Node /gameState" } | Out-Null
  Try-Step "Node /screenshot/raw" {
    $resp = Invoke-WebRequest -Uri "$NodeUrl/screenshot/raw" -TimeoutSec 10
    [pscustomobject]@{ status = $resp.StatusCode; bytes = $resp.RawContentLength }
  } | Out-Null
  Try-Step "Node /minimapSnapshot" { Assert-OkPayload (Invoke-RestMethod -Uri "$NodeUrl/minimapSnapshot" -TimeoutSec 10) "Node /minimapSnapshot" } | Out-Null
  Try-Step "Node dashboard root serves" {
    $resp = Invoke-WebRequest -Uri "$NodeUrl/" -TimeoutSec 5
    if ($resp.Content -notmatch "HeartGold DS Agent Monitor") {
      throw "Dashboard content at $NodeUrl/ is not the HeartGold dashboard."
    }
    [pscustomobject]@{ status = $resp.StatusCode; length = $resp.Content.Length; url = "$NodeUrl/" }
  } | Out-Null
  Try-Step "Dashboard serves" {
    $resp = Invoke-WebRequest -Uri $FrontendUrl -TimeoutSec 5
    if ($resp.Content -notmatch "HeartGold DS Agent Monitor") {
      throw "Dashboard content at $FrontendUrl is not the HeartGold dashboard."
    }
    [pscustomobject]@{ status = $resp.StatusCode; length = $resp.Content.Length; url = $FrontendUrl }
  } | Out-Null
  Try-Step "Codex CLI availability" {
    $version = (codex --version) -join "`n"
    [pscustomobject]@{ version = $version }
  } | Out-Null
  Try-Step "Codex Desktop observation endpoint" { Assert-OkPayload (Invoke-RestMethod -Uri "$NodeUrl/codexDesktop/observation" -TimeoutSec 20) "Codex Desktop observation" } | Out-Null
  Try-Step "Run metrics endpoint" { Assert-OkPayload (Invoke-RestMethod -Uri "$NodeUrl/benchmarkMetrics" -TimeoutSec 10) "Run metrics endpoint" } | Out-Null
} finally {
  Pop-Location
}

$passed = @($results | Where-Object { $_.ok }).Count
$failed = @($results | Where-Object { -not $_.ok }).Count
$status = if ($failed -eq 0) { "PASS" } else { "PARTIAL" }
$timestamp = Get-Date -Format o
$lines = @(
  "# HeartGold Stack Smoke Test Report",
  "",
  "- Timestamp: $timestamp",
  "- Status: $status",
  "- Passed: $passed",
  "- Failed: $failed",
  "- Bridge: $BridgeUrl",
  "- Node: $NodeUrl",
  "- Dashboard: $FrontendUrl",
  "",
  "| Check | Status | Details |",
  "| --- | --- | --- |"
)
foreach ($r in $results) {
  $safeDetails = [string]$r.details
  if ($safeDetails.Length -gt 500) { $safeDetails = $safeDetails.Substring(0, 500) + "..." }
  $safeDetails = $safeDetails.Replace("`r", " ").Replace("`n", " ").Replace("|", "/")
  $lines += "| $($r.name) | $(if ($r.ok) { 'PASS' } else { 'FAIL' }) | $safeDetails |"
}

$lines | Set-Content -LiteralPath $ReportPath -Encoding UTF8
$results | ConvertTo-Json -Depth 20
if ($failed -gt 0) {
  exit 1
}
