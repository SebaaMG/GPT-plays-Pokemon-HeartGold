param(
  [string]$Model = "gpt-5.5",
  [string]$ReasoningEffort = "xhigh"
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$Runtime = Join-Path $Root ".heartgold_runtime"
New-Item -ItemType Directory -Force -Path $Runtime | Out-Null

$schemaPath = Join-Path $Runtime "codex_provider_smoke_schema.json"
$outputPath = Join-Path $Runtime "codex_provider_smoke_output.json"
$promptPath = Join-Path $Runtime "codex_provider_smoke_prompt.txt"

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$schema = @'
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "ok": { "type": "boolean" },
    "provider": { "type": "string" },
    "model": { "type": "string" },
    "action_type": { "type": "string", "enum": ["key_press"] }
  },
  "required": ["ok", "provider", "model", "action_type"]
}
'@
[System.IO.File]::WriteAllText($schemaPath, $schema, $utf8NoBom)

$promptText = "Return JSON for a Codex CLI HeartGold provider smoke test. Use action_type=key_press."
[System.IO.File]::WriteAllText($promptPath, $promptText, $utf8NoBom)

$prompt = Get-Content -LiteralPath $promptPath -Raw
$prompt | codex -a never exec -m $Model -c "model_reasoning_effort=`"$ReasoningEffort`"" --json --output-last-message $outputPath --output-schema $schemaPath
if ($LASTEXITCODE -ne 0) { throw "codex CLI exited with code $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $outputPath)) { throw "codex CLI did not create $outputPath" }

$result = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
[pscustomobject]@{
  ok = [bool]$result.ok
  provider = $result.provider
  model = $Model
  reasoningEffort = $ReasoningEffort
  outputPath = $outputPath
} | ConvertTo-Json -Depth 10
