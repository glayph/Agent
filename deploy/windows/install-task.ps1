#Requires -Version 5.1
<##
.SYNOPSIS
  Install Agent Miki as a boot-starting Windows Scheduled Task.
.DESCRIPTION
  Registers the cross-platform supervisor under the local SYSTEM account. The
  supervisor owns crash recovery; the task owns boot/logon recovery. This file
  intentionally uses PowerShell 5.1 syntax so it works on stock Windows hosts.
#>
[CmdletBinding()]
param(
  [string]$RepoRoot = "",
  [string]$WorkspaceDir = "",
  [string]$TaskName = "Agent Miki",
  [switch]$NoStart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
  $RepoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
} else {
  $RepoRoot = (Resolve-Path $RepoRoot).Path
}
if ([string]::IsNullOrWhiteSpace($WorkspaceDir)) { $WorkspaceDir = $RepoRoot }
$WorkspaceDir = (New-Item -ItemType Directory -Force -Path $WorkspaceDir).FullName
$Supervisor = Join-Path $RepoRoot "bin\supervisor.ps1"
$GatewayEntry = Join-Path $RepoRoot "packages\gateway\dist\index.js"
if (-not (Test-Path $Supervisor)) { throw "Missing supervisor: $Supervisor" }
if (-not (Test-Path $GatewayEntry)) { throw "Gateway is not built: $GatewayEntry. Run npm run build:all first." }

$node = (Get-Command node.exe -ErrorAction Stop).Source
$taskPath = "\AgentMiki\"
$taskFullName = "$taskPath$TaskName"
$actionArgs = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Supervisor`" -WorkspaceDir `"$WorkspaceDir`""
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $actionArgs -WorkingDirectory $RepoRoot
$triggerBoot = New-ScheduledTaskTrigger -AtStartup
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$settings.DisallowStartIfOnBatteries = $false
$settings.StopIfGoingOnBatteries = $false
$description = "Agent Miki 24/7 runtime. Node: $node. Supervisor: $Supervisor"

if (Get-ScheduledTask -TaskPath $taskPath -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskPath $taskPath -TaskName $TaskName -Action $action -Trigger @($triggerBoot, $triggerLogon) -Principal $principal -Settings $settings -Description $description | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskPath $taskPath -TaskName $TaskName }

Write-Host "Registered $taskFullName"
Write-Host "Query: Get-ScheduledTask -TaskPath '$taskPath' -TaskName '$TaskName'"
Write-Host "Logs: $WorkspaceDir\data\supervisor.log"
Write-Host "Stop cleanly: .\deploy\windows\stop-task.ps1 -TaskName '$TaskName' -WorkspaceDir '$WorkspaceDir'"
