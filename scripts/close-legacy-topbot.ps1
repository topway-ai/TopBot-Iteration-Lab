param([switch]$QualificationFixture)
$ErrorActionPreference = 'Stop'
$path = Join-Path $env:LOCALAPPDATA 'Programs\TopBot\TopBot.exe'
if ($QualificationFixture) {
  $scratch = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.omb-scratch'))
  $evidence = Get-Content -Raw -LiteralPath (Join-Path $scratch 'topbot-update-package-result.json') | ConvertFrom-Json
  $base = (Resolve-Path -LiteralPath $evidence.base).Path
  if (!$evidence.passed -or (Split-Path $base -Parent) -ne $scratch -or (Split-Path $base -Leaf) -notmatch '^update-package-[A-Za-z0-9]+$') { throw 'Expected a qualified test fixture.' }
  $path = Join-Path $base 'Programs\TopBot\TopBot.exe'
}
$processes = @(Get-CimInstance Win32_Process -Filter "Name='TopBot.exe'" | Where-Object { $_.ExecutablePath -eq $path -and $_.CommandLine -notmatch '(?:^|\s)--type=' })
if (!$processes.Count) { return }
if ($processes.Count -ne 1) { throw 'Expected exactly one legacy TopBot main process.' }
$process = Get-Process -Id $processes[0].ProcessId
$listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -State Listen | Where-Object { $_.LocalPort -in @(8799,18799,28799) -and (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Path -eq $path })
if (!$QualificationFixture -and $listeners.Count -ne 1) { throw 'Cannot verify a unique active local workspace.' }
foreach ($listener in $listeners) {
  $url = 'http://127.0.0.1:' + $listener.LocalPort
  $status = Invoke-RestMethod "$url/api/move/freeze" -TimeoutSec 5
  $call = Invoke-RestMethod "$url/api/live/call" -TimeoutSec 5
  if ($status.frozen -ne $false -or $status.busy -or $call.call) { throw 'TopBot is busy or frozen; refusing to close it.' }
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class LegacyTopBotMaintenance {
  [StructLayout(LayoutKind.Sequential)] struct Unique { public uint pid, low, high; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint h, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmRegisterResources(uint h, uint files, IntPtr paths, uint count, [In] Unique[] apps, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")] static extern int RmShutdown(uint h, uint flags, IntPtr callback);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  static void Check(int code) { if(code != 0) throw new System.ComponentModel.Win32Exception(code); }
  public static void Close(uint pid, long started) {
    uint h; Check(RmStartSession(out h, 0, new StringBuilder(33)));
    try {
      Check(RmRegisterResources(h, 0, IntPtr.Zero, 1, new[]{new Unique{pid=pid, low=(uint)started, high=(uint)(started>>32)}}, 0, IntPtr.Zero));
      Check(RmShutdown(h, 0, IntPtr.Zero));
    } finally { RmEndSession(h); }
  }
}
'@
[LegacyTopBotMaintenance]::Close($process.Id, $process.StartTime.ToFileTimeUtc())
if (!$process.WaitForExit(15000)) { throw 'Legacy TopBot did not exit. No forced termination.' }
Write-Output 'Legacy TopBot main process exited after a non-forced Windows Restart Manager request.'
