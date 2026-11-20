param(
  [Parameter(Mandatory=$true)][ValidateSet('Apply','Rollback')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$PlanPath,
  [switch]$NoRecoveryRegistration,
  [int]$ProbeSeconds = 30,
  [int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
$Job = Split-Path -Parent ([IO.Path]::GetFullPath($PlanPath))
$Shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
$Arguments = @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-File', ('"' + (Join-Path $Job 'runner.ps1') + '"'),
  '-Mode', $Mode, '-PlanPath', ('"' + $PlanPath + '"'), '-ProbeSeconds', $ProbeSeconds, '-TimeoutSeconds', $TimeoutSeconds)
if ($NoRecoveryRegistration) { $Arguments += '-NoRecoveryRegistration' }
$Child = Start-Process -FilePath $Shell -ArgumentList $Arguments -WorkingDirectory $Job -WindowStyle Hidden -PassThru
@{ pid=$Child.Id } | ConvertTo-Json -Compress
