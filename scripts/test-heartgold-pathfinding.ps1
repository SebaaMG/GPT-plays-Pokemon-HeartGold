param(
  [string]$BridgeUrl = $(if ($env:PYTHON_BASE_URL) { $env:PYTHON_BASE_URL } else { "http://127.0.0.1:8010" }),
  [int]$TargetDx = 1,
  [int]$TargetDy = 0
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$state = Invoke-RestMethod -Uri "$BridgeUrl/requestData" -TimeoutSec 15
if (-not $state.ok) { throw "requestData failed" }

$tmp = Join-Path $env:TEMP ("heartgold_state_" + [guid]::NewGuid().ToString("N") + ".json")
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tmp, ($state.data | ConvertTo-Json -Depth 100), $utf8NoBom)

$nodeCode = @"
const fs = require('fs');
const { findHeartGoldPath } = require('./server/src/ai/heartgoldPathfinder');
const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const pos = data.current_trainer_data.position;
const target = { x: Number(pos.x) + Number(process.argv[2]), y: Number(pos.y) + Number(process.argv[3]), map_id: String(pos.map_id) };
Promise.resolve(findHeartGoldPath(data, target.x, target.y, target.map_id, 'smoke pathfinding to adjacent tile'))
  .then((result) => console.log(JSON.stringify({ ok: true, target, result }, null, 2)))
  .catch((error) => {
    console.log(JSON.stringify({ ok: false, target, error: error.message }, null, 2));
    process.exitCode = 1;
  });
"@

$nodeOutput = node -e $nodeCode $tmp $TargetDx $TargetDy
$nodeStatus = $LASTEXITCODE
Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
if ($nodeStatus -ne 0) {
  if ($nodeOutput) { $nodeOutput | Write-Host }
  throw "Node pathfinding check failed with exit code $nodeStatus."
}
if ($nodeOutput) { $nodeOutput | Write-Host }
