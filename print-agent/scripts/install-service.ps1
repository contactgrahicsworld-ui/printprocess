<#
.SYNOPSIS
  Installs Mansa Print Agent as an auto-starting Windows service (restart on failure,
  depends on the Print Spooler). Default wrapper: WinSW (downloaded by download-tools.ps1).
  Alternative: -Wrapper NSSM -NssmPath C:\tools\nssm.exe

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install-service.ps1
  powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -ServiceUser ".\shopuser"   # run as a user who sees per-user printers
#>
[CmdletBinding()]
param(
  [string]$InstallDir = "$env:ProgramFiles\MansaPrintAgent",
  [string]$SourceExe = '',
  [string]$ServiceName = 'MansaPrintAgent',
  [ValidateSet('WinSW', 'NSSM')][string]$Wrapper = 'WinSW',
  [string]$NssmPath = '',
  # Empty = LocalSystem (recommended when printers are installed for "all users").
  [string]$ServiceUser = '',
  [switch]$DelayedStart
)
$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this script in an elevated (Administrator) PowerShell.' }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$exe = Join-Path $InstallDir 'MansaPrintAgent.exe'
if ($SourceExe -and ((Resolve-Path $SourceExe).Path -ne $exe)) { Copy-Item -Force $SourceExe $exe }
if (-not (Test-Path $exe)) { throw "Agent executable not found: $exe (pass -SourceExe)" }
if (-not (Test-Path (Join-Path $InstallDir 'SumatraPDF.exe'))) { Write-Warning 'SumatraPDF.exe not in install dir; run download-tools.ps1 or set sumatraPath in config.json' }

$dataRoot = Join-Path $env:ProgramData 'MansaPrintAgent'
$logDir = Join-Path $dataRoot 'logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
if (-not (Test-Path (Join-Path $dataRoot 'config.json'))) { Write-Warning "No config yet. Run: `"$exe`" setup" }

# Program data: SYSTEM + Administrators only (config holds the DPAPI-protected secret).
icacls $dataRoot /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
if ($ServiceUser) { icacls $dataRoot /grant "${ServiceUser}:(OI)(CI)M" | Out-Null }

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) { throw "Service $ServiceName already exists. Run uninstall-service.ps1 first." }

$cred = $null
if ($ServiceUser) { $cred = Get-Credential -UserName $ServiceUser -Message "Password for service account $ServiceUser" }

if ($Wrapper -eq 'WinSW') {
  $wrapperExe = Join-Path $InstallDir 'MansaPrintAgentService.exe'
  if (-not (Test-Path $wrapperExe)) { throw "WinSW not found at $wrapperExe; run download-tools.ps1" }
  $delayed = if ($DelayedStart) { '<delayedAutoStart>true</delayedAutoStart>' } else { '' }
  $account = ''
  if ($cred) {
    $pw = $cred.GetNetworkCredential().Password
    $account = "<serviceaccount><username>$([Security.SecurityElement]::Escape($ServiceUser))</username><password>$([Security.SecurityElement]::Escape($pw))</password><allowservicelogon>true</allowservicelogon></serviceaccount>"
  }
  $xml = @"
<service>
  <id>$ServiceName</id>
  <name>Mansa Print Agent</name>
  <description>Mansa Printer QR-to-print agent: claims approved print jobs and prints them via the Windows spooler.</description>
  <executable>$exe</executable>
  <arguments>run</arguments>
  <workingdirectory>$InstallDir</workingdirectory>
  <startmode>Automatic</startmode>
  $delayed
  <depend>Spooler</depend>
  <stoptimeout>20 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <onfailure action="restart" delay="60 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$logDir</logpath>
  <log mode="roll-by-size"><sizeThreshold>5120</sizeThreshold><keepFiles>5</keepFiles></log>
  $account
</service>
"@
  Set-Content -Path (Join-Path $InstallDir 'MansaPrintAgentService.xml') -Value $xml -Encoding UTF8
  icacls (Join-Path $InstallDir 'MansaPrintAgentService.xml') /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null
  & $wrapperExe install
  if ($LASTEXITCODE -ne 0) { throw "WinSW install failed ($LASTEXITCODE)" }
} else {
  if (-not $NssmPath) { $NssmPath = Join-Path $InstallDir 'nssm.exe' }
  if (-not (Test-Path $NssmPath)) { throw "nssm.exe not found at $NssmPath (download nssm 2.24 win64 from https://nssm.cc/download and verify its hash)" }
  & $NssmPath install $ServiceName $exe run
  & $NssmPath set $ServiceName DisplayName 'Mansa Print Agent'
  & $NssmPath set $ServiceName Description 'Mansa Printer QR-to-print agent'
  & $NssmPath set $ServiceName AppDirectory $InstallDir
  & $NssmPath set $ServiceName Start $(if ($DelayedStart) { 'SERVICE_DELAYED_AUTO_START' } else { 'SERVICE_AUTO_START' })
  & $NssmPath set $ServiceName DependOnService Spooler
  & $NssmPath set $ServiceName AppStdout (Join-Path $logDir 'service-stdout.log')
  & $NssmPath set $ServiceName AppStderr (Join-Path $logDir 'service-stderr.log')
  & $NssmPath set $ServiceName AppRotateFiles 1
  & $NssmPath set $ServiceName AppRotateBytes 5242880
  & $NssmPath set $ServiceName AppExit Default Restart
  & $NssmPath set $ServiceName AppRestartDelay 10000
  & $NssmPath set $ServiceName AppStopMethodConsole 20000
  if ($cred) { & $NssmPath set $ServiceName ObjectName $ServiceUser $cred.GetNetworkCredential().Password }
}

# Belt and braces: SCM restarts on crash too.
sc.exe failure $ServiceName reset= 3600 actions= restart/10000/restart/30000/restart/60000 | Out-Null
Start-Service -Name $ServiceName
Start-Sleep -Seconds 3
Get-Service -Name $ServiceName | Format-Table -AutoSize Name, Status, StartType
Write-Host "Logs: $logDir\agent.log"
