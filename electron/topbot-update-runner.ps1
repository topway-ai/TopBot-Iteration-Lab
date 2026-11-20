param(
  [Parameter(Mandatory=$true)][ValidateSet('Prepare','Apply','Recover','Rollback')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$PlanPath,
  [switch]$NoRecoveryRegistration,
  [int]$ProbeSeconds = 30,
  [int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'
[System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$PlanPath = [IO.Path]::GetFullPath($PlanPath)
$Job = Split-Path -Parent $PlanPath
$Root = Split-Path -Parent (Split-Path -Parent $Job)
$StatePath = Join-Path $Job 'state.json'
$Lock = $null
$Plan = $null
$Started = [DateTime]::UtcNow

function Write-Json($Path, $Value) {
  $Temp = "$Path.tmp"
  [IO.File]::WriteAllText($Temp, (ConvertTo-Json -InputObject $Value -Depth 12), $Utf8)
  if ([IO.File]::Exists($Path)) { [IO.File]::Replace($Temp, $Path, [NullString]::Value) }
  else { [IO.File]::Move($Temp, $Path) }
}
function Read-Json($Path) {
  if ([IO.File]::Exists($Path)) { return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json) }
  return $null
}
function Read-Health($Path) {
  try {
    # The app replaces this file while it is being polled. Permit that rename while reading the old snapshot.
    $Share = [IO.FileShare]::Read -bor [IO.FileShare]::Delete
    $Stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, $Share)
    try {
      $Reader = [IO.StreamReader]::new($Stream, $Utf8)
      try { return ($Reader.ReadToEnd() | ConvertFrom-Json) } finally { $Reader.Dispose() }
    } finally { $Stream.Dispose() }
  } catch [IO.IOException] {
    # A missing or briefly locked heartbeat does not count as healthy; the normal deadline still applies.
    return $null
  }
}
function Read-Utc($Value) {
  if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
  return [DateTimeOffset]::Parse([string]$Value, [Globalization.CultureInfo]::InvariantCulture).UtcDateTime
}
function State($Phase, $Message = '') {
  Write-Json $StatePath @{ phase=$Phase; message=$Message; version=$Plan.version; previousVersion=$Plan.previousVersion; at=[DateTime]::UtcNow.ToString('o') }
}
function Assert-Tree($Path) {
  $Full = [IO.Path]::GetFullPath($Path)
  $Cursor = $Full
  while ($Cursor) {
    if (Test-Path -LiteralPath $Cursor) {
      $Item = Get-Item -LiteralPath $Cursor -Force
      if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Linked paths are not allowed: $Cursor" }
    }
    $Parent = Split-Path -Parent $Cursor
    if ($Parent -eq $Cursor) { break }
    $Cursor = $Parent
  }
  return $Full
}
function Owned($Path) {
  $Full = [IO.Path]::GetFullPath($Path)
  if (-not $Full.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path leaves the update workspace.' }
  if ((Test-Path -LiteralPath $Full) -and ((Get-Item -LiteralPath $Full -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked update targets are not allowed.' }
  return $Full
}
function Move-Owned($Source, $Target) {
  $Source = Assert-Tree $Source
  $Target = Assert-Tree $Target
  foreach ($Path in @($Source, $Target)) {
    if ($Path -ne $Plan.installDir) { $null = Owned $Path }
  }
  [IO.Directory]::Move($Source, $Target)
}
function Resources($Needed = 0) {
  $Free = (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1024
  if ($Free -lt 3GB) { throw 'Update paused: less than 3 GB RAM available.' }
  $Drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($Root))
  if ($Drive.AvailableFreeSpace -lt ($Needed + 3GB)) { throw 'Update paused: not enough disk space including a 3 GB reserve.' }
}
function Assert-Plan {
  if ((Split-Path -Leaf $PlanPath) -ne 'plan.json' -or (Split-Path -Leaf (Split-Path -Parent $Job)) -ne 'transactions') { throw 'Invalid transaction location.' }
  $null = Assert-Tree $Job
  $null = Owned $Job
  $Plan = Read-Json $PlanPath
  if ($Plan.schema -ne 1 -or $Plan.version -notmatch '^\d+\.\d+\.\d+(-topbot\.\d+)?$' -or
      $Plan.previousVersion -notmatch '^\d+\.\d+\.\d+(-topbot\.\d+)?$' -or
      $Plan.token -notmatch '^[a-f0-9]{64}$' -or $Plan.sha256 -notmatch '^[a-f0-9]{64}$' -or
      $Plan.dataEpoch -ne 1 -or $Plan.bytes -le 0 -or $Plan.bytes -gt 3GB -or
      $Plan.unpackedBytes -le 0 -or $Plan.unpackedBytes -gt 8GB) { throw 'Invalid update plan.' }
  $Plan.installDir = Assert-Tree $Plan.installDir
  if ([IO.Path]::GetFileName($Plan.installDir) -ne 'TopBot' -or $Plan.installDir.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) -or
      $Root.StartsWith($Plan.installDir, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetPathRoot($Root) -ne [IO.Path]::GetPathRoot($Plan.installDir)) { throw 'Invalid or cross-volume install target.' }
  $Plan.dataDirs = @(foreach ($Source in $Plan.dataDirs) {
    $Full = Assert-Tree $Source
    if ($Full.Length -lt 10 -or $Root.StartsWith($Full, [StringComparison]::OrdinalIgnoreCase) -or
        $Full.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase) -or
        $Full.StartsWith($Plan.installDir, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid data snapshot path.' }
    $Full
  })
  $Plan.profileDir = Assert-Tree $Plan.profileDir
  if (-not (@($Plan.dataDirs | Where-Object { $Plan.profileDir -eq $_ -or $Plan.profileDir.StartsWith($_ + '\', [StringComparison]::OrdinalIgnoreCase) }).Count)) { throw 'Desktop profile is outside the snapshot sources.' }
  return $Plan
}
function Prepare {
  Resources $Plan.unpackedBytes
  $Archive = Owned (Join-Path $Job 'update.zip')
  if ((Get-Item -LiteralPath $Archive).Length -ne $Plan.bytes -or (Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Plan.sha256) { throw 'Update archive integrity verification failed.' }
  $Stage = Owned (Join-Path $Job 'staged')
  if (Test-Path -LiteralPath $Stage) { throw 'Staging directory already exists; use a new transaction.' }
  $Zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $Total = [long]0
    $Names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    if ($Zip.Entries.Count -gt 50000) { throw 'Too many archive entries.' }
    foreach ($Entry in $Zip.Entries) {
      $Name = $Entry.FullName.Replace('\','/')
      if (-not $Name -or $Name.StartsWith('/') -or $Name.Contains(':') -or $Name.Contains('//') -or
          $Name -match '(^|/)\.\.?(/|$)' -or $Name -match '[ .](/|$)' -or
          $Name -match '(^|/)(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])([./]|$)' -or
          (($Entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000 -or -not $Names.Add($Name.TrimEnd('/'))) { throw "Unsafe archive entry: $Name" }
      $Total += $Entry.Length
      if ($Total -gt $Plan.unpackedBytes -or $Total -gt 8GB) { throw 'Archive expands beyond its declared bound.' }
      $null = Owned (Join-Path $Stage $Name)
    }
    [IO.Directory]::CreateDirectory($Stage) | Out-Null
    $LastCheck = [DateTime]::UtcNow
    foreach ($Entry in $Zip.Entries) {
      $Target = Owned (Join-Path $Stage $Entry.FullName)
      if ($Entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory($Target) | Out-Null; continue }
      [IO.Directory]::CreateDirectory((Split-Path -Parent $Target)) | Out-Null
      $InputStream = $Entry.Open()
      $OutputStream = [IO.File]::Open($Target, [IO.FileMode]::CreateNew)
      try { $InputStream.CopyTo($OutputStream, 65536) } finally { $InputStream.Dispose(); $OutputStream.Dispose() }
      if (([DateTime]::UtcNow - $LastCheck).TotalSeconds -gt 2) { Resources; $LastCheck=[DateTime]::UtcNow }
      if (([DateTime]::UtcNow - $Started).TotalMinutes -gt 15) { throw 'Preparation exceeded its 15 minute limit.' }
    }
  } finally { $Zip.Dispose() }
  $Build = Read-Json (Join-Path $Stage 'resources\topbot-build.json')
  if (-not (Test-Path -LiteralPath (Join-Path $Stage 'TopBot.exe')) -or
      -not (Test-Path -LiteralPath (Join-Path $Stage 'resources\app.asar')) -or
      $null -eq $Build -or $Build.version -ne $Plan.version -or $Build.dataEpoch -ne $Plan.dataEpoch -or
      $Build.repository -ne 'topway-ai/TopBot-Iteration-Lab') { throw 'Staged package identity does not match the update plan.' }
  State 'prepared'
}
function App-Processes {
  return @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Plan.installDir + '\', [StringComparison]::OrdinalIgnoreCase) })
}
function Wait-Closed($Seconds) {
  $End = [DateTime]::UtcNow.AddSeconds($Seconds)
  while (@(App-Processes).Count -gt 0) {
    if ([DateTime]::UtcNow -ge $End) { throw 'TopBot did not close in time; no forced termination of the old app.' }
    Start-Sleep -Milliseconds 500
  }
}
function Snapshot($Name = 'data-snapshot') {
  $Dest = Owned (Join-Path $Job $Name)
  [IO.Directory]::CreateDirectory($Dest) | Out-Null
  $Total = [long]0
  $Count = 0
  $Records = @()
  $Links = @()
  $LastCheck = [DateTime]::MinValue
  for ($Index=0; $Index -lt $Plan.dataDirs.Count; $Index++) {
    $Source = $Plan.dataDirs[$Index]
    if (-not (Test-Path -LiteralPath $Source)) { continue }
    $TargetRoot = Join-Path $Dest ([string]$Index)
    $Queue = New-Object 'System.Collections.Generic.Queue[string]'
    $Queue.Enqueue($Source)
    while ($Queue.Count -gt 0) {
      $Dir = $Queue.Dequeue()
      $null = Assert-Tree $Dir
      foreach ($Item in Get-ChildItem -LiteralPath $Dir -Force) {
        $Relative = $Item.FullName.Substring($Source.Length).TrimStart('\')
        if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
          if (-not $Item.PSIsContainer -or $Item.LinkType -ne 'Junction' -or @($Item.Target).Count -ne 1) { throw 'Data snapshot contains an unsupported link; update stopped.' }
          $Target = [IO.Path]::GetFullPath(@($Item.Target)[0])
          if (-not $Target.StartsWith($Source + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Data snapshot contains a link outside its source; update stopped.' }
          $null = Assert-Tree $Target
          if (-not (Test-Path -LiteralPath $Target -PathType Container)) { throw 'Data snapshot link target is missing.' }
          $TargetRelative = $Target.Substring($Source.Length).TrimStart('\')
          if (@($TargetRelative.Split('\') | Where-Object { $_ -in @('Cache','Code Cache','GPUCache','DawnCache','Crashpad') }).Count) { throw 'Data snapshot link points to an excluded cache.' }
          if ($Links.Count -ge 10000) { throw 'Too many data snapshot links.' }
          $Links += @{ sourceIndex=$Index; path=$Relative; target=$TargetRelative; type='junction' }
          continue
        }
        if ($Item.PSIsContainer) {
          if ($Item.Name -notin @('Cache','Code Cache','GPUCache','DawnCache','Crashpad')) { $Queue.Enqueue($Item.FullName) }
          continue
        }
        if ($Item.Name -in @('SingletonLock','SingletonCookie','SingletonSocket')) { continue }
        $Total += $Item.Length; $Count++
        if ($Total -gt 12GB -or $Count -gt 100000) { throw 'Data snapshot exceeds its bounded budget; update stopped.' }
        if (([DateTime]::UtcNow - $LastCheck).TotalSeconds -gt 2) { Resources $Item.Length; $LastCheck=[DateTime]::UtcNow }
        $Target = Owned (Join-Path $TargetRoot $Relative)
        [IO.Directory]::CreateDirectory((Split-Path -Parent $Target)) | Out-Null
        [IO.File]::Copy($Item.FullName, $Target, $false)
        if ((Get-Item -LiteralPath $Target).Length -ne $Item.Length) { throw 'Incomplete data snapshot.' }
        if (([DateTime]::UtcNow - $Started).TotalMinutes -gt 15) { throw 'Snapshot exceeded its time limit.' }
      }
    }
    $Records += @{ source=$Source; copy=$TargetRoot }
  }
  Write-Json (Join-Path $Dest 'snapshot.json') @{ directories=$Records; bytes=$Total; files=$Count; links=$Links; excludes=@('Cache','Code Cache','GPUCache','DawnCache','Crashpad','SingletonLock','SingletonCookie','SingletonSocket') }
}
function Recovery-Command {
  $Script = Owned (Join-Path $Root 'recover.ps1')
  $Shell = [System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
  $Command = '"' + $Shell + '" -NoProfile -NonInteractive -WindowStyle Hidden -File "' + $Script + '"'
  if ($Command.Length -gt 260) { throw 'Recovery command exceeds the Windows RunOnce length limit.' }
  return $Command
}
function Register-Recovery {
  if ($NoRecoveryRegistration) { return }
  $Command = Recovery-Command
  $Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  $Existing = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\RunOnce', '!TopBotIterationLabUpdateRecovery', $null)
  $Recovery = Read-Json (Join-Path $Root 'recovery.json')
  if ($Existing -and ($Existing -ne $Command -or $null -eq $Recovery -or $Recovery.plan -ne $PlanPath)) { throw 'Another interrupted update needs recovery first.' }
  $Bootstrap = @'
$ErrorActionPreference = 'Stop'
$record = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'recovery.json') -Raw | ConvertFrom-Json
$plan = [IO.Path]::GetFullPath($record.plan)
$parent = Join-Path $PSScriptRoot 'transactions'
if (-not $plan.StartsWith($parent + '\', [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($plan) -ne 'plan.json') { throw 'Invalid recovery journal.' }
& (Join-Path (Split-Path -Parent $plan) 'runner.ps1') -Mode Recover -PlanPath $plan
exit $LASTEXITCODE
'@
  [IO.File]::WriteAllText((Owned (Join-Path $Root 'recover.ps1')), $Bootstrap, $Utf8)
  Write-Json (Join-Path $Root 'recovery.json') @{ plan=$PlanPath }
  $null = New-Item -Path $Key -Force
  $null = New-ItemProperty -Path $Key -Name '!TopBotIterationLabUpdateRecovery' -Value $Command -PropertyType String -Force
}
function Clear-Recovery {
  if ($NoRecoveryRegistration) { return }
  $Key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  $Existing = [Microsoft.Win32.Registry]::GetValue('HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\RunOnce', '!TopBotIterationLabUpdateRecovery', $null)
  $Recovery = Read-Json (Join-Path $Root 'recovery.json')
  if ($Existing -eq (Recovery-Command) -and $null -ne $Recovery -and $Recovery.plan -eq $PlanPath) { Remove-ItemProperty -Path $Key -Name '!TopBotIterationLabUpdateRecovery' -ErrorAction SilentlyContinue }
}
function Start-App($Ticket = $null) {
  $Args = @()
  if ($Ticket) { $Args += ('--topbot-update-ticket="' + $Ticket + '"') }
  $Args += ('--user-data-dir="' + $Plan.profileDir + '"')
  $Start = @{ FilePath=(Join-Path $Plan.installDir 'TopBot.exe'); WorkingDirectory=$Plan.installDir; PassThru=$true }
  if ($Args.Count) { $Start.ArgumentList=$Args }
  return (Start-Process @Start)
}
function Stop-Candidate {
  Write-Json (Join-Path $Job 'stop.json') @{ token=$Plan.token }
  try { Wait-Closed 15; return } catch { }
  $Candidate = Read-Json (Join-Path $Job 'candidate.json')
  $After = if ($null -ne $Candidate) { (Read-Utc $Candidate.at).AddSeconds(-5) } else { $Started.AddSeconds(-5) }
  foreach ($Proc in App-Processes) {
    if ($Proc.CreationDate.ToUniversalTime() -ge $After) { Stop-Process -Id $Proc.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  Wait-Closed 10
}
function Rollback {
  $Old = Owned (Join-Path $Job 'previous')
  if (-not (Test-Path -LiteralPath $Old)) { throw 'Previous app is unavailable; refusing a destructive recovery.' }
  State 'rolling-back'
  Stop-Candidate
  $Blocked = Read-Json (Join-Path $Root 'blocked.json')
  Write-Json (Join-Path $Root 'blocked.json') @(@($Blocked) + $Plan.version | Where-Object { $_ } | Select-Object -Unique -Last 50)
  if (Test-Path -LiteralPath $Plan.installDir) { Move-Owned $Plan.installDir (Join-Path $Job ('failed-' + [Guid]::NewGuid().ToString('N'))) }
  Move-Owned $Old $Plan.installDir
  State 'rolled-back' 'Previous program restored. Current chats, keys and data were not overwritten.'
  Clear-Recovery
  $null = Start-App
}
function Handoff {
  Register-Recovery
  State 'waiting-for-exit'
  Write-Json (Join-Path $Job 'helper-ready.json') @{ token=$Plan.token; pid=$PID }
  $End = [DateTime]::UtcNow.AddSeconds(20)
  while ($true) {
    $Go = Read-Json (Join-Path $Job 'go.json')
    if ($null -ne $Go -and $Go.token -eq $Plan.token -and $Go.pid -eq $PID) { break }
    if ([DateTime]::UtcNow -gt $End) { throw 'Update handoff was not confirmed; retaining the old installation.' }
    Start-Sleep -Milliseconds 200
  }
  Wait-Closed 90
}
function Apply {
  $State = Read-Json $StatePath
  if ($null -eq $State -or $State.phase -ne 'prepared') { throw 'Update is not prepared.' }
  if (-not (Test-Path -LiteralPath (Join-Path $Plan.installDir 'TopBot.exe'))) { throw 'Current TopBot installation is missing.' }
  Resources
  Handoff
  Snapshot
  Resources
  State 'switching'
  Move-Owned $Plan.installDir (Join-Path $Job 'previous')
  Move-Owned (Join-Path $Job 'staged') $Plan.installDir
  State 'starting'
  $Ticket = Join-Path $Job 'ticket.json'
  Write-Json $Ticket @{ token=$Plan.token; version=$Plan.version; dataEpoch=$Plan.dataEpoch; installDir=$Plan.installDir }
  $Process = Start-App $Ticket
  Write-Json (Join-Path $Job 'candidate.json') @{ pid=$Process.Id; at=[DateTime]::UtcNow.ToString('o') }
  $End = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $HealthySince = $null
  while ([DateTime]::UtcNow -lt $End) {
    Start-Sleep -Milliseconds 500
    $Process.Refresh()
    if ($Process.HasExited) { throw 'Updated TopBot exited before its health check completed.' }
    $Health = Read-Health (Join-Path $Job 'health.json')
    $Age = if ($null -ne $Health) { ([DateTime]::UtcNow - (Read-Utc $Health.at)).TotalSeconds } else { 999 }
    if ($null -ne $Health -and $Health.token -eq $Plan.token -and $Health.pid -eq $Process.Id -and
        $Health.version -eq $Plan.version -and $Health.dataEpoch -eq $Plan.dataEpoch -and $Health.ready -eq $true -and
        $Age -ge -5 -and $Age -lt 10) {
      if ($null -eq $HealthySince) { $HealthySince = [DateTime]::UtcNow }
      if (([DateTime]::UtcNow - $HealthySince).TotalSeconds -ge $ProbeSeconds) {
        Write-Json (Join-Path $Root 'last-good.json') @{ job=$Job; version=$Plan.version; previousVersion=$Plan.previousVersion; dataEpoch=$Plan.dataEpoch }
        State 'committed'
        Clear-Recovery
        return
      }
    } else { $HealthySince = $null }
  }
  throw 'Updated TopBot did not pass the sustained desktop and server health check.'
}

try {
  $Plan = Assert-Plan
  $Lock = [IO.File]::Open((Join-Path $Root 'update.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  if ($Mode -eq 'Prepare') { Prepare }
  elseif ($Mode -eq 'Apply') { Apply }
  elseif ($Mode -eq 'Rollback') {
    if (-not (Test-Path -LiteralPath (Join-Path $Job 'previous'))) { throw 'No previous version is available.' }
    Resources
    Handoff
    Snapshot ('rollback-data-' + [Guid]::NewGuid().ToString('N'))
    Rollback
  }
  else {
    $State = Read-Json $StatePath
    if ($null -ne $State -and $State.phase -in @('committed','rolled-back','failed')) { Clear-Recovery }
    elseif ($null -ne $State -and $State.phase -in @('switching','starting','rolling-back','recovery-needed') -and (Test-Path -LiteralPath (Join-Path $Job 'previous'))) { Rollback }
    else {
      State 'failed' 'Interrupted before the program switch; original installation retained.'
      Clear-Recovery
      if (@(App-Processes).Count -eq 0) { $null = Start-App }
    }
  }
  exit 0
} catch {
  $Message = $_.Exception.Message
  if ($null -ne $Plan -and $null -ne $Lock) {
    try {
      $FailedState = Read-Json $StatePath
      if ($Mode -ne 'Prepare' -and $null -ne $FailedState -and $FailedState.phase -in @('switching','starting','rolling-back','recovery-needed') -and (Test-Path -LiteralPath (Join-Path $Job 'previous'))) { Rollback }
      else {
        State 'failed' $Message; Clear-Recovery
        if ($Mode -ne 'Prepare' -and @(App-Processes).Count -eq 0) { $null = Start-App }
      }
    } catch {
      $Message += ' Recovery requires attention: ' + $_.Exception.Message
      State 'recovery-needed' $Message
    }
  }
  [Console]::Error.WriteLine($Message)
  exit 1
} finally {
  if ($null -ne $Lock) { $Lock.Dispose() }
}
