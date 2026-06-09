param(
  [string]$BridgeUrl = "http://127.0.0.1:8010",
  [int]$X = 210,
  [int]$Y = 170
)

$ErrorActionPreference = "Stop"

$body = @{
  commands = @(
    @{
      type = "touch"
      x = $X
      y = $Y
      frames = 8
    }
  )
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri "$BridgeUrl/sendCommands" -ContentType "application/json" -Body $body -TimeoutSec 30 |
  ConvertTo-Json -Depth 20
