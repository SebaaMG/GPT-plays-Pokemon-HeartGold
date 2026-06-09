param(
  [string]$BridgeUrl = "http://127.0.0.1:8010",
  [string]$Name = "smoke_roundtrip.State"
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SavePath = Join-Path $Root ".heartgold_runtime\saves\$Name"
$saveBody = @{ path = $SavePath } | ConvertTo-Json

$save = Invoke-RestMethod -Method Post -Uri "$BridgeUrl/saveState" -ContentType "application/json" -Body $saveBody -TimeoutSec 30
$load = Invoke-RestMethod -Method Post -Uri "$BridgeUrl/loadState" -ContentType "application/json" -Body $saveBody -TimeoutSec 30

$ok = [bool]($save.ok -and $load.ok -and (Test-Path -LiteralPath $SavePath))
if (-not $ok) {
  throw "HeartGold save/load test failed: save=$($save.ok) load=$($load.ok) exists=$(Test-Path -LiteralPath $SavePath)"
}

[pscustomobject]@{
  ok = $ok
  path = $SavePath
  save = $save
  load = $load
} | ConvertTo-Json -Depth 20
