param(
  [int]$BridgePort = 8010,
  [int]$NodePort = 9885,
  [int]$FrontendPort = 5173,
  [int]$SpeedMode = 100,
  [string]$Model = "",
  [int]$ModelImageScale = 3,
  [ValidateSet("codex-desktop", "codex-cli", "openai")]
  [string]$AgentProvider = "codex-desktop",
  [string]$RuntimeDir = "",
  [string]$DataDir = "",
  [switch]$NoAgent,
  [switch]$NoDashboard,
  [switch]$NoBootstrap,
  [switch]$KeepExistingEmulators,
  [switch]$ForceSharedEmulatorPath,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
if (-not $RuntimeDir) { $RuntimeDir = ".heartgold_runtime" }
$Runtime = if ([System.IO.Path]::IsPathRooted($RuntimeDir)) { $RuntimeDir } else { Join-Path $Root $RuntimeDir }
$Runtime = [System.IO.Path]::GetFullPath($Runtime)
$Logs = Join-Path $Runtime "logs"
$ServerDir = Join-Path $Root "server"
$BridgeUrl = "http://127.0.0.1:$BridgePort"
$NodeUrl = "http://127.0.0.1:$NodePort"
$ExpectedDataDir = if ($DataDir) { $DataDir } else { "gpt_data_heartgold" }

New-Item -ItemType Directory -Force -Path $Runtime, $Logs | Out-Null

function First-NonEmptyString {
  param([object[]]$Values)
  foreach ($value in $Values) {
    $text = [string]$value
    if (-not [string]::IsNullOrWhiteSpace($text)) { return $text.Trim() }
  }
  return ""
}

function Resolve-AgentModel {
  if ($AgentProvider -eq "codex-desktop") {
    return First-NonEmptyString @($Model, $env:CODEX_DESKTOP_MODEL, $env:CODEX_MODEL, $env:OPENAI_MODEL)
  }
  if ($AgentProvider -eq "codex-cli") {
    return First-NonEmptyString @($Model, $env:CODEX_MODEL, $env:CODEX_DESKTOP_MODEL, $env:OPENAI_MODEL)
  }
  return First-NonEmptyString @($Model, $env:OPENAI_MODEL)
}

$ResolvedModel = Resolve-AgentModel
if ($AgentProvider -eq "codex-cli" -and -not $ResolvedModel) {
  throw "HeartGold codex-cli requires an explicit model. Pass -Model <model> or set CODEX_MODEL, CODEX_DESKTOP_MODEL, or OPENAI_MODEL."
}
if ($ResolvedModel) { $Model = $ResolvedModel }

function Stop-PidFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  $raw = (Get-Content $Path -ErrorAction SilentlyContinue | Select-Object -First 1)
  $pidValue = 0
  if ([int]::TryParse($raw, [ref]$pidValue)) {
    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Wait-HttpOk {
  param([string]$Url, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    try {
      return Invoke-RestMethod -Uri $Url -TimeoutSec 2
    } catch {
      Start-Sleep -Milliseconds 500
    }
  }
  throw "Timed out waiting for $Url"
}

function Wait-BridgeSnapshot {
  param([string]$Url, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    try {
      $snapshot = Invoke-RestMethod -Uri $Url -TimeoutSec 45
      if ($snapshot.ok) { return $snapshot }
      $lastError = "Bridge returned ok=false"
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 750
  }
  throw "Timed out waiting for usable bridge snapshot from $Url. Last error: $lastError"
}

function Test-PortListening {
  param([int]$Port)
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  return $listeners.Count -gt 0
}

function Test-CommandLineContainsAny {
  param([string]$CommandLine, [string[]]$Patterns)
  foreach ($pattern in $Patterns) {
    if ($CommandLine.IndexOf($pattern, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
      return $true
    }
  }
  return $false
}

function Stop-HeartGoldPortListeners {
  param([int]$Port, [string[]]$CommandLinePatterns)
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  $pids = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  foreach ($pidValue in $pids) {
    if (-not $pidValue) { continue }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction SilentlyContinue
    $commandLine = if ($process -and $process.CommandLine) { [string]$process.CommandLine } else { "" }
    if (Test-CommandLineContainsAny -CommandLine $commandLine -Patterns $CommandLinePatterns) {
      Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
    }
  }
}

function Assert-PortFree {
  param([int]$Port, [string]$Label)
  $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($listeners.Count -eq 0) { return }

  $descriptions = @()
  foreach ($listener in $listeners) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $commandLine = if ($process -and $process.CommandLine) { [string]$process.CommandLine } else { "<unknown command line>" }
    $descriptions += "pid $($listener.OwningProcess): $commandLine"
  }
  throw "$Label port $Port is already in use after cleanup: $($descriptions -join '; ')"
}

function Resolve-FreePort {
  param([int]$PreferredPort, [int]$MaxAttempts = 20)
  for ($offset = 0; $offset -lt $MaxAttempts; $offset++) {
    $candidate = $PreferredPort + $offset
    if (-not (Test-PortListening $candidate)) { return $candidate }
  }
  throw "No free port found starting at $PreferredPort"
}

function Resolve-WindowlessPython {
  $pythonw = Get-Command pythonw -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pythonw -and $pythonw.Source) { return $pythonw.Source }

  $python = Get-Command python -ErrorAction Stop | Select-Object -First 1
  return $python.Source
}

function Set-ProcessPrioritySafe {
  param(
    [System.Diagnostics.Process]$Process = $null,
    [int]$Id = 0,
    [ValidateSet("Idle", "BelowNormal", "Normal", "AboveNormal", "High")]
    [string]$Priority = "Normal",
    [long]$ProcessorAffinity = 0
  )
  try {
    $target = if ($Process) { $Process } elseif ($Id -gt 0) { Get-Process -Id $Id -ErrorAction Stop } else { $null }
    if ($target) {
      $target.PriorityClass = $Priority
      if ($ProcessorAffinity -gt 0) {
        $target.ProcessorAffinity = [intptr]$ProcessorAffinity
      }
    }
  } catch {
    Write-Warning "Could not set process priority $Priority for process id $Id."
  }
}

function Resolve-ProcessorAffinityMask {
  param([string]$Value, [long]$Default)
  if ([string]::IsNullOrWhiteSpace($Value)) { return $Default }
  $trimmed = $Value.Trim()
  try {
    if ($trimmed.StartsWith("0x", [System.StringComparison]::OrdinalIgnoreCase)) {
      return [Convert]::ToInt64($trimmed.Substring(2), 16)
    }
    return [int64]$trimmed
  } catch {
    return $Default
  }
}

function Resolve-DefaultEmuHawkAffinityMask {
  $limit = [Math]::Max(1, [Math]::Min([Environment]::ProcessorCount, 4))
  $mask = [int64]0
  for ($i = 0; $i -lt $limit; $i++) {
    $mask = $mask -bor ([int64]1 -shl $i)
  }
  return $mask
}

function Resolve-DefaultHelperAffinityMask {
  $count = [Environment]::ProcessorCount
  if ($count -le 4) { return [int64]0 }
  $limit = [Math]::Min($count, 62)
  $mask = [int64]0
  for ($i = 4; $i -lt $limit; $i++) {
    $mask = $mask -bor ([int64]1 -shl $i)
  }
  return $mask
}

function Get-JsonOrNull {
  param([string]$Url, [int]$TimeoutSec = 4)
  try {
    return Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec
  } catch {
    return $null
  }
}

function Test-ExistingHeartGoldStack {
  $nodeHealth = Get-JsonOrNull "$NodeUrl/health"
  if ($null -eq $nodeHealth -or $nodeHealth.ok -ne $true) { return $false }
  if ($nodeHealth.gameProfile -ne "heartgold") { return $false }
  if ($nodeHealth.agentProvider -ne $AgentProvider) { return $false }
  if ($nodeHealth.pythonBaseUrl -ne $BridgeUrl) { return $false }
  if ($nodeHealth.dataDir -ne $ExpectedDataDir) { return $false }
  if ($Model -and ([string]$nodeHealth.model) -ne $Model) {
    Write-Warning "A HeartGold stack is already running on the requested ports with model '$($nodeHealth.model)', not '$Model'. Start was not reused."
    return $false
  }

  $bridgeHealth = Get-JsonOrNull "$BridgeUrl/health"
  if ($null -eq $bridgeHealth -or $bridgeHealth.ok -ne $true) { return $false }
  if ($bridgeHealth.running -ne $true) { return $false }
  if ($bridgeHealth.runtimeDir) {
    $runningRuntime = [System.IO.Path]::GetFullPath([string]$bridgeHealth.runtimeDir)
    if ($runningRuntime -ne $Runtime) {
      Write-Warning "A HeartGold stack is already running on the requested ports for runtime '$runningRuntime', not '$Runtime'. Start was not reused."
      return $false
    }
  }

  return $true
}

$EmuHawkAffinityMask = Resolve-ProcessorAffinityMask -Value $env:HEARTGOLD_EMUHAWK_AFFINITY_MASK -Default (Resolve-DefaultEmuHawkAffinityMask)
$HelperAffinityMask = Resolve-ProcessorAffinityMask -Value $env:HEARTGOLD_HELPER_AFFINITY_MASK -Default (Resolve-DefaultHelperAffinityMask)
$env:HEARTGOLD_EMUHAWK_AFFINITY_MASK = "0x{0:X}" -f $EmuHawkAffinityMask
$env:HEARTGOLD_EMUHAWK_PRIORITY_CLASS = if ($env:HEARTGOLD_EMUHAWK_PRIORITY_CLASS) { $env:HEARTGOLD_EMUHAWK_PRIORITY_CLASS } else { "HIGH_PRIORITY_CLASS" }

function Set-HeartGoldStackScheduling {
  $owned = @(
    @{ Path = Join-Path $Runtime "emuhawk_pid.txt"; Priority = "High"; Affinity = $EmuHawkAffinityMask },
    @{ Path = Join-Path $Runtime "bridge_pid.txt"; Priority = "BelowNormal"; Affinity = $HelperAffinityMask },
    @{ Path = Join-Path $Runtime "node_pid.txt"; Priority = "BelowNormal"; Affinity = $HelperAffinityMask },
    @{ Path = Join-Path $Runtime "frontend_pid.txt"; Priority = "BelowNormal"; Affinity = $HelperAffinityMask }
  )
  foreach ($item in $owned) {
    if (-not (Test-Path -LiteralPath $item.Path)) { continue }
    $raw = Get-Content -LiteralPath $item.Path -ErrorAction SilentlyContinue | Select-Object -First 1
    $pidValue = 0
    if ([int]::TryParse($raw, [ref]$pidValue)) {
      Set-ProcessPrioritySafe -Id $pidValue -Priority $item.Priority -ProcessorAffinity $item.Affinity
    }
  }
}

function Get-HeartGoldRuntimeEmuHawkProcesses {
  $escapedRuntime = [Regex]::Escape($Runtime)
  return @(
    Get-CimInstance Win32_Process -Filter "name = 'EmuHawk.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match $escapedRuntime }
  )
}

function Stop-DuplicateHeartGoldEmulators {
  $runtimeEmulators = @(Get-HeartGoldRuntimeEmuHawkProcesses)
  if ($runtimeEmulators.Count -le 1) { return }

  $emuhawkPidPath = Join-Path $Runtime "emuhawk_pid.txt"
  $keepPid = 0
  $rawPid = if (Test-Path -LiteralPath $emuhawkPidPath) {
    Get-Content -LiteralPath $emuhawkPidPath -ErrorAction SilentlyContinue | Select-Object -First 1
  } else {
    $null
  }
  [void][int]::TryParse($rawPid, [ref]$keepPid)

  $keepProcess = $runtimeEmulators | Where-Object { [int]$_.ProcessId -eq $keepPid } | Select-Object -First 1
  if (-not $keepProcess) {
    $keepProcess = $runtimeEmulators | Sort-Object CreationDate -Descending | Select-Object -First 1
    $keepPid = [int]$keepProcess.ProcessId
    $keepPid | Set-Content -LiteralPath $emuhawkPidPath
  }

  $runtimeEmulators |
    Where-Object { [int]$_.ProcessId -ne $keepPid } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if (-not $Restart -and (Test-ExistingHeartGoldStack)) {
  Set-HeartGoldStackScheduling
  Write-Host "Reusing existing HeartGold benchmark stack."
  Write-Host "Bridge:    $BridgeUrl"
  Write-Host "Agent:     $NodeUrl"
  if (-not $NoDashboard) {
    Write-Host "Dashboard: $NodeUrl/"
  } else {
    Write-Host "Agent API: $NodeUrl/"
  }
  Write-Host "Runtime:   $Runtime"
  Write-Host "Data dir:  $ExpectedDataDir"
  if ($AgentProvider -eq "codex-desktop") {
    Write-Host "Desktop observation: $NodeUrl/codexDesktop/observation"
    Write-Host "Desktop action:      $NodeUrl/codexDesktop/action"
  }
  return
}

Stop-PidFile (Join-Path $Runtime "node_pid.txt")
Stop-PidFile (Join-Path $Runtime "frontend_pid.txt")
Stop-PidFile (Join-Path $Runtime "bridge_pid.txt")
if (-not $KeepExistingEmulators) {
  Stop-PidFile (Join-Path $Runtime "emuhawk_pid.txt")
}
Stop-HeartGoldPortListeners -Port $NodePort -CommandLinePatterns @("server\index.js", "server/index.js")
Stop-HeartGoldPortListeners -Port $BridgePort -CommandLinePatterns @("heartgold_benchmark\heartgold_bridge.py", "heartgold_benchmark/heartgold_bridge.py")
Assert-PortFree -Port $NodePort -Label "Node API"
Assert-PortFree -Port $BridgePort -Label "Python bridge"

$BizHawkExe = $env:BIZHAWK_EXE
if (-not $BizHawkExe) {
  $BizHawkExe = Join-Path $Root ".codex_tmp\BizHawk-2.11\EmuHawk.exe"
}
if (-not $KeepExistingEmulators) {
  $escapedRuntime = [Regex]::Escape($Runtime)
  Get-CimInstance Win32_Process -Filter "name = 'EmuHawk.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $escapedRuntime } |
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
} else {
  Stop-DuplicateHeartGoldEmulators
}

$env:HEARTGOLD_BRIDGE_PORT = [string]$BridgePort
$env:HEARTGOLD_RUNTIME_DIR = $Runtime
$env:HEARTGOLD_BOOTSTRAP_ON_LAUNCH = "false"
$env:HEARTGOLD_SPEED_MODE = [string]$SpeedMode
$env:HEARTGOLD_OBSERVATION_MODE = if ($env:HEARTGOLD_OBSERVATION_MODE) { $env:HEARTGOLD_OBSERVATION_MODE } else { "ram_assisted" }
$env:HEARTGOLD_EXPOSE_ORACLE = if ($env:HEARTGOLD_EXPOSE_ORACLE) { $env:HEARTGOLD_EXPOSE_ORACLE } else { "false" }
$env:HEARTGOLD_STATE_CONFIDENCE_REQUIRED = if ($env:HEARTGOLD_STATE_CONFIDENCE_REQUIRED) { $env:HEARTGOLD_STATE_CONFIDENCE_REQUIRED } else { "true" }
$env:HEARTGOLD_MODEL_IMAGE_SCALE = [string]([Math]::Max(1, [Math]::Min(4, $ModelImageScale)))

$WindowlessPython = Resolve-WindowlessPython

$bridgeOut = Join-Path $Logs "bridge.out.log"
$bridgeErr = Join-Path $Logs "bridge.err.log"
Remove-Item -LiteralPath $bridgeOut, $bridgeErr -Force -ErrorAction SilentlyContinue
$bridge = Start-Process -FilePath $WindowlessPython `
  -ArgumentList @("heartgold_benchmark\heartgold_bridge.py") `
  -WorkingDirectory $Root `
  -RedirectStandardOutput $bridgeOut `
  -RedirectStandardError $bridgeErr `
  -WindowStyle Hidden `
  -PassThru
Set-ProcessPrioritySafe -Process $bridge -Priority BelowNormal -ProcessorAffinity $HelperAffinityMask
$bridge.Id | Set-Content -LiteralPath (Join-Path $Runtime "bridge_pid.txt")

Wait-HttpOk "$BridgeUrl/health" 30 | Out-Null
Invoke-RestMethod -Method Post -Uri "$BridgeUrl/launchEmulator" -TimeoutSec 45 | Out-Null
Stop-DuplicateHeartGoldEmulators
$emuhawkPid = 0
$emuhawkPidPath = Join-Path $Runtime "emuhawk_pid.txt"
$emuhawkPidRaw = if (Test-Path -LiteralPath $emuhawkPidPath) { Get-Content -LiteralPath $emuhawkPidPath -ErrorAction SilentlyContinue | Select-Object -First 1 } else { $null }
if (-not [int]::TryParse($emuhawkPidRaw, [ref]$emuhawkPid)) {
  $escapedRuntime = [Regex]::Escape($Runtime)
  $emuhawkProcess = Get-CimInstance Win32_Process -Filter "name = 'EmuHawk.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match $escapedRuntime } |
    Select-Object -First 1
  $emuhawkPid = if ($emuhawkProcess) { [int]$emuhawkProcess.ProcessId } else { 0 }
}
Set-ProcessPrioritySafe -Id $emuhawkPid -Priority High -ProcessorAffinity $EmuHawkAffinityMask
if (-not $NoBootstrap) {
  Start-Sleep -Seconds 3
  Invoke-RestMethod -Method Post -Uri "$BridgeUrl/bootstrapIntro" -TimeoutSec 90 | Out-Null
  Wait-BridgeSnapshot "$BridgeUrl/requestData" 90 | Out-Null
} else {
  Write-Warning "Skipping intro bootstrap because -NoBootstrap was specified; still waiting for a fresh bridge snapshot."
  Wait-BridgeSnapshot "$BridgeUrl/requestData" 90 | Out-Null
}

$env:GAME_PROFILE = "heartgold"
$env:GPT_DATA_DIR = if ($DataDir) { $DataDir } else { "gpt_data_heartgold" }
$env:AGENT_PROVIDER = $AgentProvider
if ($Model) {
  if ($AgentProvider -eq "openai") {
    $env:OPENAI_MODEL = $Model
  } else {
    $env:CODEX_MODEL = $Model
    if ($AgentProvider -eq "codex-desktop") { $env:CODEX_DESKTOP_MODEL = $Model }
  }
}
$env:CODEX_REASONING_EFFORT = if ($env:CODEX_REASONING_EFFORT) { $env:CODEX_REASONING_EFFORT } else { "xhigh" }
$env:CODEX_DESKTOP_REASONING_EFFORT = if ($env:CODEX_DESKTOP_REASONING_EFFORT) { $env:CODEX_DESKTOP_REASONING_EFFORT } else { $env:CODEX_REASONING_EFFORT }
$env:PYTHON_BASE_URL = $BridgeUrl
$env:WS_PORT = [string]$NodePort
$env:AGENT_AUTOSTART = if ($AgentProvider -eq "codex-desktop" -or $NoAgent) { "false" } else { "true" }
$env:AUTO_LAUNCH_EMULATOR = "false"
$env:AUTO_BOOTSTRAP_INTRO = if ($NoBootstrap) { "false" } else { "true" }
if ($AgentProvider -ne "openai") {
  Remove-Item Env:\OPENAI_API_KEY -ErrorAction SilentlyContinue
}

$nodeOut = Join-Path $Logs "node.out.log"
$nodeErr = Join-Path $Logs "node.err.log"
Remove-Item -LiteralPath $nodeOut, $nodeErr -Force -ErrorAction SilentlyContinue
$node = Start-Process -FilePath "node" `
  -ArgumentList @("index.js") `
  -WorkingDirectory $ServerDir `
  -RedirectStandardOutput $nodeOut `
  -RedirectStandardError $nodeErr `
  -WindowStyle Hidden `
  -PassThru
Set-ProcessPrioritySafe -Process $node -Priority BelowNormal -ProcessorAffinity $HelperAffinityMask
$node.Id | Set-Content -LiteralPath (Join-Path $Runtime "node_pid.txt")
$nodeHealth = Wait-HttpOk "$NodeUrl/health" 30
if ($nodeHealth.gameProfile -ne "heartgold") { throw "Node server health reported unexpected game profile '$($nodeHealth.gameProfile)'." }
if ($nodeHealth.agentProvider -ne $AgentProvider) { throw "Node server health reported unexpected provider '$($nodeHealth.agentProvider)'." }
if ($nodeHealth.pythonBaseUrl -ne $BridgeUrl) { throw "Node server health reported unexpected bridge URL '$($nodeHealth.pythonBaseUrl)'." }
if ($Model -and ([string]$nodeHealth.model) -ne $Model) {
  throw "Node server health reported model '$($nodeHealth.model)', expected '$Model'."
}

if (-not $NoDashboard) {
  $NodeDashboardUrl = "http://127.0.0.1:$NodePort/"
  $requestedFrontendPort = $FrontendPort
  $FrontendPort = Resolve-FreePort $FrontendPort
  if ($FrontendPort -ne $requestedFrontendPort) {
    Write-Warning "Frontend port $requestedFrontendPort is already in use; using $FrontendPort for the HeartGold dashboard."
  }
  $FrontendUrl = "http://127.0.0.1:$FrontendPort"
  $FrontendConnectedUrl = "$FrontendUrl/?host=127.0.0.1&port=$NodePort"
  $FrontendPort | Set-Content -LiteralPath (Join-Path $Runtime "frontend_port.txt")
  $NodeDashboardUrl | Set-Content -LiteralPath (Join-Path $Runtime "dashboard_url.txt")
  $FrontendConnectedUrl | Set-Content -LiteralPath (Join-Path $Runtime "dashboard_fallback_url.txt")

  $frontendOut = Join-Path $Logs "frontend.out.log"
  $frontendErr = Join-Path $Logs "frontend.err.log"
  Remove-Item -LiteralPath $frontendOut, $frontendErr -Force -ErrorAction SilentlyContinue
  $frontend = Start-Process -FilePath $WindowlessPython `
    -ArgumentList @("-m", "http.server", [string]$FrontendPort, "-d", "frontend") `
    -WorkingDirectory $Root `
    -RedirectStandardOutput $frontendOut `
    -RedirectStandardError $frontendErr `
    -WindowStyle Hidden `
    -PassThru
  Set-ProcessPrioritySafe -Process $frontend -Priority BelowNormal -ProcessorAffinity $HelperAffinityMask
  $frontend.Id | Set-Content -LiteralPath (Join-Path $Runtime "frontend_pid.txt")
}

Write-Host "HeartGold benchmark stack started."
Write-Host "Bridge:    $BridgeUrl"
Write-Host "Agent:     http://127.0.0.1:$NodePort"
if (-not $NoDashboard) {
  Write-Host "Dashboard: http://127.0.0.1:$NodePort/"
  Write-Host "Dashboard fallback: http://127.0.0.1:$FrontendPort/?host=127.0.0.1&port=$NodePort"
  Write-Host "Agent API: http://127.0.0.1:$NodePort/"
} else {
  Write-Host "Agent API: http://127.0.0.1:$NodePort/"
}
Write-Host "Speed:     $SpeedMode"
Write-Host "Provider:  $AgentProvider"
Write-Host "Model img: x$env:HEARTGOLD_MODEL_IMAGE_SCALE"
Write-Host "Runtime:   $Runtime"
Write-Host "Data dir:  $env:GPT_DATA_DIR"
if ($AgentProvider -eq "codex-desktop") {
  Write-Host "Desktop observation: http://127.0.0.1:$NodePort/codexDesktop/observation"
  Write-Host "Desktop action:      http://127.0.0.1:$NodePort/codexDesktop/action"
}
Write-Host "Logs:      $Logs"
