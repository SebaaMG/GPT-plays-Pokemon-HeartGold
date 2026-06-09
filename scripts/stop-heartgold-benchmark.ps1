param(
  [string]$RuntimeDir = "",
  [switch]$KeepEmulator,
  [switch]$ForceSharedEmulatorPath
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $RuntimeDir) { $RuntimeDir = ".heartgold_runtime" }
$Runtime = if ([System.IO.Path]::IsPathRooted($RuntimeDir)) { $RuntimeDir } else { Join-Path $Root $RuntimeDir }
$Runtime = [System.IO.Path]::GetFullPath($Runtime)

function Stop-PidFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  $raw = (Get-Content $Path -ErrorAction SilentlyContinue | Select-Object -First 1)
  $pidValue = 0
  if ([int]::TryParse($raw, [ref]$pidValue)) {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $pidValue -Timeout 5 -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

Stop-PidFile (Join-Path $Runtime "node_pid.txt")
Stop-PidFile (Join-Path $Runtime "frontend_pid.txt")
Stop-PidFile (Join-Path $Runtime "bridge_pid.txt")
if (-not $KeepEmulator) {
  Stop-PidFile (Join-Path $Runtime "emuhawk_pid.txt")
}

$escapedRuntime = [Regex]::Escape($Runtime)
$RuntimeLeaf = Split-Path -Path $Runtime -Leaf
$escapedRuntimeLeaf = if ([string]::IsNullOrWhiteSpace($RuntimeLeaf)) { "" } else { [Regex]::Escape($RuntimeLeaf) }
$BridgeScriptRegex = [Regex]::Escape("heartgold_bridge.py")

Get-CimInstance Win32_Process -Filter "name = 'node.exe' or name = 'python.exe' or name = 'pythonw.exe' or name = 'py.exe' or name = 'cmd.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessId -ne $PID -and ($_.CommandLine -match $escapedRuntime -or (-not [string]::IsNullOrWhiteSpace($escapedRuntimeLeaf) -and $_.CommandLine -match $escapedRuntimeLeaf)) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-CimInstance Win32_Process -Filter "name = 'python.exe' or name = 'pythonw.exe' or name = 'py.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match $BridgeScriptRegex -and ($_.CommandLine -match [Regex]::Escape($Root) -or $_.CommandLine -match 'heartgold_benchmark[\\/]+heartgold_bridge[.]py') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$CodexCliState = Join-Path $Root "server\gpt_data_heartgold\codex_cli"
Get-CimInstance Win32_Process -Filter "name = 'node.exe' or name = 'codex.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like "*$CodexCliState*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

if (-not $KeepEmulator) {
  $BizHawkExe = $env:BIZHAWK_EXE
  if (-not $BizHawkExe) {
    $BizHawkExe = Join-Path $Root ".codex_tmp\BizHawk-2.11\EmuHawk.exe"
  }
  Get-CimInstance Win32_Process -Filter "name = 'EmuHawk.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $escapedRuntime -or (-not [string]::IsNullOrWhiteSpace($escapedRuntimeLeaf) -and $_.CommandLine -match $escapedRuntimeLeaf) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

  if ($ForceSharedEmulatorPath) {
    $BizHawkFull = $null
    try { $BizHawkFull = (Resolve-Path $BizHawkExe -ErrorAction Stop).Path } catch {}
    if ($BizHawkFull) {
      Get-Process EmuHawk -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -eq $BizHawkFull } |
        Stop-Process -Force -ErrorAction SilentlyContinue
    }
  }
}

Write-Host "HeartGold benchmark stack stopped for runtime: $Runtime"
