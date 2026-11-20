param([ValidateSet('Open','Record','Verify')][string]$Mode = 'Verify')
$ErrorActionPreference = 'Stop'
$scratch = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.omb-scratch'))
$report = Get-Content -Raw -LiteralPath (Join-Path $scratch 'topbot-update-package-result.json') | ConvertFrom-Json
$base = (Resolve-Path -LiteralPath $report.base).Path
if (!$report.passed -or (Split-Path $base -Parent) -ne $scratch -or (Split-Path $base -Leaf) -notmatch '^update-package-[A-Za-z0-9]+$') { throw 'Expected a qualified disposable fixture.' }
$root = (Resolve-Path -LiteralPath $report.updates).Path
if ((Split-Path $root -Parent) -ne $HOME -or (Split-Path $root -Leaf) -notmatch '^\.topbot-update-test-[A-Za-z0-9]+$') { throw 'Unexpected update root.' }
$job = Join-Path $root 'transactions\qualification'
$plan = Get-Content -Raw -LiteralPath (Join-Path $job 'plan.json') | ConvertFrom-Json
$phase = (Get-Content -Raw -LiteralPath (Join-Path $job 'state.json') | ConvertFrom-Json).phase
$homeDir = Join-Path $base 'home'
$data = Join-Path $homeDir 'data'
$install = Join-Path $base 'Programs\TopBot'
$profile = Join-Path $homeDir 'profile'
if ($install -ne $plan.installDir -or $profile -ne $plan.profileDir -or $plan.dataDirs[0] -ne $data) { throw 'Fixture paths do not match qualification.' }
$sentinel = Join-Path $data 'after-upgrade-before-rollback.txt'
$marker = 'Written after the real package committed.'
if ($Mode -eq 'Verify') {
  if ($phase -ne 'rolled-back' -or [IO.File]::ReadAllText($sentinel) -ne $marker) { throw 'Rollback or data preservation not verified.' }
  $expected = [IO.File]::ReadAllText((Join-Path $base 'previous-asar.sha256'))
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $install 'resources\app.asar')).Hash -ne $expected) { throw 'Restored app differs from the previous archive.' }
  $before = Get-ChildItem -LiteralPath $job -Directory -Filter 'rollback-data-*' | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '0\after-upgrade-before-rollback.txt') } | Select-Object -First 1
  if (!$before -or [IO.File]::ReadAllText((Join-Path $before.FullName '0\after-upgrade-before-rollback.txt')) -ne $marker) { throw 'Rollback snapshot missing.' }
  [pscustomobject]@{ current=$plan.previousVersion; phase=$phase; retainedNewData=$true; rollbackSnapshot=$true; job=$job } | ConvertTo-Json
  return
}
if ($phase -ne 'committed') { throw 'Only open a successfully upgraded test package.' }
[IO.File]::WriteAllText((Join-Path $base 'previous-asar.sha256'), (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $job 'previous\resources\app.asar')).Hash)
if ($Mode -eq 'Record') { return }
if (@(Get-Process TopBot -ErrorAction SilentlyContinue | Where-Object Path -eq (Join-Path $install 'TopBot.exe')).Count) { throw 'Fixture is already open.' }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot '..\electron\topbot-update-launch.ps1') -Destination (Join-Path $job 'launch.ps1')
$runtime = (Get-Process -Id $PID).Path
if ((Split-Path $runtime -Leaf) -ne 'pwsh.exe') { throw 'Run from the PowerShell 7 updater runtime.' }
[IO.File]::WriteAllText((Join-Path $root 'runtime.json'), (@{powershell=$runtime} | ConvertTo-Json -Compress))
[IO.File]::WriteAllText($sentinel, $marker)
$start = [Diagnostics.ProcessStartInfo]::new((Join-Path $install 'TopBot.exe'))
$start.UseShellExecute = $false
$start.WorkingDirectory = $install
$start.ArgumentList.Add('--user-data-dir=' + $profile)
$start.Environment.Clear()
@{ SystemRoot=$env:SystemRoot; WINDIR=$env:WINDIR; PATH=((Split-Path $runtime -Parent) + ';' + (Join-Path $env:SystemRoot 'System32')); HOME=$homeDir; USERPROFILE=$homeDir;
   APPDATA=(Join-Path $homeDir 'AppData\Roaming'); LOCALAPPDATA=(Join-Path $homeDir 'AppData\Local'); TEMP=$base; TMP=$base; OMB_DATA_DIR=$data; TOPBOT_UPDATE_ROOT=$root }.GetEnumerator() | ForEach-Object { $start.Environment[$_.Key]=$_.Value }
$started = [Diagnostics.Process]::Start($start)
Write-Output "Opened qualification fixture PID $($started.Id)."
