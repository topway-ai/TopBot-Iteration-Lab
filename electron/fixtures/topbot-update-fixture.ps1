param([string]$Mode, [string]$Source, [string]$Destination)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if ($Mode -eq 'Compile') {
  & "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /reference:System.Web.Extensions.dll "/out:$Destination" (Join-Path $PSScriptRoot 'topbot-update-app.cs')
  if ($LASTEXITCODE -ne 0) { throw 'Fixture compilation failed.' }
} elseif ($Mode -eq 'Zip') {
  [IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination)
} elseif ($Mode -eq 'ZipFast') {
  [IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination, [IO.Compression.CompressionLevel]::NoCompression, $false)
} elseif ($Mode -eq 'Traversal') {
  $Zip = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
  try { $Entry=$Zip.CreateEntry('../outside.txt'); $Writer=New-Object IO.StreamWriter($Entry.Open()); $Writer.Write('outside'); $Writer.Dispose() } finally { $Zip.Dispose() }
} else { throw 'Unknown fixture operation.' }
