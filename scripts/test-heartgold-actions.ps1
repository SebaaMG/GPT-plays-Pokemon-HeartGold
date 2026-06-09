param(
  [string]$BridgeUrl = "http://127.0.0.1:8010"
)

$ErrorActionPreference = "Stop"

function Invoke-JsonPost {
  param([string]$Url, [string]$Json)
  Invoke-RestMethod -Method Post -Uri $Url -ContentType "application/json" -Body $Json -TimeoutSec 30
}

$health = Invoke-RestMethod -Uri "$BridgeUrl/health" -TimeoutSec 5
$before = Invoke-RestMethod -Uri "$BridgeUrl/requestData" -TimeoutSec 15
$pressA = Invoke-JsonPost "$BridgeUrl/sendCommands" '{"commands":[{"type":"press","buttons":["a"],"frames":8}]}'
$pressRight = Invoke-JsonPost "$BridgeUrl/sendCommands" '{"commands":[{"type":"press","buttons":["right"],"frames":8}]}'
$after = Invoke-RestMethod -Uri "$BridgeUrl/requestData" -TimeoutSec 15

$ok = [bool]($health.ok -and $before.ok -and $pressA.ok -and $pressRight.ok -and $after.ok)
if (-not $ok) {
  throw "HeartGold action test failed: health=$($health.ok) before=$($before.ok) pressA=$($pressA.ok) pressRight=$($pressRight.ok) after=$($after.ok)"
}

[pscustomobject]@{
  ok = $ok
  bridgeHealth = $health
  pressA = $pressA
  pressRight = $pressRight
  beforeFrame = $before.data.emulator.frame
  afterFrame = $after.data.emulator.frame
} | ConvertTo-Json -Depth 20
