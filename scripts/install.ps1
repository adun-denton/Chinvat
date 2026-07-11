#requires -version 5
<#
  Chinvat installer for Windows.
    .\scripts\install.ps1              install + build
    .\scripts\install.ps1 -Autostart   also register a logon task that starts the hub
    .\scripts\install.ps1 -Start       build, then start the hub now
#>
param(
  [switch]$Autostart,
  [switch]$Start
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Write-Host "Chinvat repo: $repo" -ForegroundColor Cyan

try { $node = (node --version) } catch { throw 'Node.js 20+ is required. Install from https://nodejs.org and re-run.' }
Write-Host "Node $node"
$major = [int]($node.TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node 20+ required (found $node)." }

Push-Location $repo
try {
  Write-Host 'Installing dependencies...' -ForegroundColor Cyan
  npm install --no-fund --no-audit
  Write-Host 'Building hub + dashboard...' -ForegroundColor Cyan
  npm run build
} finally { Pop-Location }

if ($Autostart) {
  $action  = New-ScheduledTaskAction -Execute 'node.exe' -Argument "`"$repo\hub\dist\index.js`"" -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -AtLogOn
  $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName 'Chinvat Hub' -Action $action -Trigger $trigger -Settings $set -Force | Out-Null
  Write-Host 'Registered logon task "Chinvat Hub".' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Done. Start the hub with:  npm start' -ForegroundColor Green
Write-Host 'Then open the console at:   http://localhost:7777' -ForegroundColor Green

if ($Start) {
  Write-Host 'Starting hub...' -ForegroundColor Cyan
  Push-Location $repo
  Start-Process 'http://localhost:7777'
  node hub\dist\index.js
  Pop-Location
}
