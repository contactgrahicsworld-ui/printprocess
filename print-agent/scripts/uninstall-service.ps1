<#
.SYNOPSIS  Stops and removes the Mansa Print Agent service. -RemoveData also deletes %ProgramData%\MansaPrintAgent (config, job log, outbox, logs).
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:ProgramFiles\MansaPrintAgent",
  [string]$ServiceName = 'MansaPrintAgent',
  [string]$NssmPath = '',
  [switch]$RemoveData
)
$ErrorActionPreference = 'Stop'
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run as Administrator.' }

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') { Stop-Service -Name $ServiceName -Force; $svc.WaitForStatus('Stopped', '00:00:30') }
  $winsw = Join-Path $InstallDir 'MansaPrintAgentService.exe'
  if (-not $NssmPath) { $NssmPath = Join-Path $InstallDir 'nssm.exe' }
  if ((Test-Path $winsw) -and (Test-Path (Join-Path $InstallDir 'MansaPrintAgentService.xml'))) { & $winsw uninstall }
  elseif (Test-Path $NssmPath) { & $NssmPath remove $ServiceName confirm }
  else { sc.exe delete $ServiceName | Out-Null }
  Write-Host "Service $ServiceName removed."
} else { Write-Host "Service $ServiceName not installed." }

if ($RemoveData) {
  $outbox = Join-Path $env:ProgramData 'MansaPrintAgent\data\outbox.jsonl'
  if ((Test-Path $outbox) -and ((Get-Item $outbox).Length -gt 0)) {
    Write-Warning 'outbox.jsonl still has unsent status updates; they will be lost.'
  }
  Remove-Item -Recurse -Force (Join-Path $env:ProgramData 'MansaPrintAgent') -ErrorAction SilentlyContinue
  Write-Host 'Program data removed.'
}
