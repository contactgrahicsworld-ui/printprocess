<#
.SYNOPSIS
  Downloads SumatraPDF (portable) and WinSW (service wrapper) into the agent install folder
  and verifies their SHA256 hashes. Run in an elevated PowerShell.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\download-tools.ps1
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:ProgramFiles\MansaPrintAgent",
  [string]$SumatraVersion = '3.5.2',
  # SHA256 of SumatraPDF-3.5.2-64.zip and of the .exe inside it (pinned 2026-10-30).
  [string]$SumatraZipSha256 = '66ccb395c9184dce6822dfbb9970c877383b3ead6d9417b5106a844aac512989',
  [string]$SumatraExeSha256 = '290e4aa7ed64c728138711c011e89aab7aa48dbc1ae430371dc2be4100b92bf0',
  [string]$WinSWVersion = '2.12.0',
  # SHA256 of WinSW-x64.exe v2.12.0 (pinned 2026-10-30).
  [string]$WinSWSha256 = '05b82d46ad331cc16bdc00de5c6332c1ef818df8ceefcd49c726553209b3a0da',
  [switch]$SkipWinSW
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Assert-Hash([string]$Path, [string]$Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -Path $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) {
    Remove-Item -Force $Path -ErrorAction SilentlyContinue
    throw "SHA256 mismatch for $Path`n  expected $Expected`n  actual   $actual"
  }
  Write-Host "  sha256 OK $actual"
}

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$tmp = Join-Path $env:TEMP ("mpa-dl-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
try {
  $zipUrl = "https://www.sumatrapdfreader.org/dl/rel/$SumatraVersion/SumatraPDF-$SumatraVersion-64.zip"
  $zip = Join-Path $tmp 'sumatra.zip'
  Write-Host "Downloading $zipUrl"
  Invoke-WebRequest -UseBasicParsing -Uri $zipUrl -OutFile $zip
  Assert-Hash $zip $SumatraZipSha256
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $exe = Get-ChildItem -Path $tmp -Filter 'SumatraPDF*.exe' | Select-Object -First 1
  Assert-Hash $exe.FullName $SumatraExeSha256
  Copy-Item -Force $exe.FullName (Join-Path $InstallDir 'SumatraPDF.exe')
  Write-Host "SumatraPDF -> $InstallDir\SumatraPDF.exe"

  if (-not $SkipWinSW) {
    $wUrl = "https://github.com/winsw/winsw/releases/download/v$WinSWVersion/WinSW-x64.exe"
    $w = Join-Path $tmp 'WinSW-x64.exe'
    Write-Host "Downloading $wUrl"
    Invoke-WebRequest -UseBasicParsing -Uri $wUrl -OutFile $w
    Assert-Hash $w $WinSWSha256
    Copy-Item -Force $w (Join-Path $InstallDir 'MansaPrintAgentService.exe')
    Write-Host "WinSW -> $InstallDir\MansaPrintAgentService.exe"
  }
  Write-Host "`nPin this in config.json: `"sumatraSha256`": `"$SumatraExeSha256`""
} finally {
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
