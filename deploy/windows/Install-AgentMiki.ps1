<#
.SYNOPSIS
    Install Agent Miki as a boot-triggered Windows Task Scheduler service.

.DESCRIPTION
    Registers the repository's hardened supervisor as a startup task. The
    supervisor owns gateway readiness, bounded restart, stop/exhausted sentinels
    and process-tree cleanup. This script does not contain provider secrets.

    Run with -DryRun to inspect the resolved configuration without changing the
    host. Normal installation requires an elevated PowerShell session.
#>

[CmdletBinding()]
param(
    [string]$RepoRoot = "",
    [string]$WorkspaceDir = "",
    [string]$TaskName = "Agent-Miki",
    [string]$RunAs = "NT AUTHORITY\LOCAL SERVICE",
    [int]$MaxRestarts = 5,
    [int]$ReadyTimeoutSec = 45,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $RepoRoot) {
    $RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
}
if (-not $WorkspaceDir) { $WorkspaceDir = $RepoRoot }
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$WorkspaceDir = [IO.Path]::GetFullPath($WorkspaceDir)
$Supervisor = Join-Path $RepoRoot "bin\supervisor.ps1"
if (-not (Test-Path $Supervisor)) { throw "Supervisor not found: $Supervisor" }
if ($MaxRestarts -lt 1) { throw "MaxRestarts must be at least 1; use the explicit supervisor override for diagnostics only." }
if ($ReadyTimeoutSec -lt 5) { throw "ReadyTimeoutSec must be at least 5 seconds." }

function Show-Plan {
    Write-Host "Task name       : $TaskName"
    Write-Host "Run as          : $RunAs"
    Write-Host "Repository root : $RepoRoot"
    Write-Host "Workspace       : $WorkspaceDir"
    Write-Host "Supervisor      : $Supervisor"
    Write-Host "Max restarts    : $MaxRestarts"
    Write-Host "Ready timeout   : ${ReadyTimeoutSec}s"
}

Show-Plan
if ($DryRun) {
    Write-Host "Dry run passed. No scheduled task or files were changed."
    exit 0
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
    throw "Run the installer from an elevated PowerShell session."
}

New-Item -ItemType Directory -Path (Join-Path $WorkspaceDir "data") -Force | Out-Null
$envDir = Join-Path $WorkspaceDir "config"
New-Item -ItemType Directory -Path $envDir -Force | Out-Null
$envFile = Join-Path $envDir "agent-miki.env"
if (-not (Test-Path $envFile)) {
    @"
MIKI_SOURCE_ROOT=$RepoRoot
MIKI_RUNTIME_ROOT=$RepoRoot
MIKI_WORKSPACE_DIR=$WorkspaceDir
GATEWAY_PORT=18800
SUPERVISOR_MAX_RESTARTS=$MaxRestarts
SUPERVISOR_READY_TIMEOUT_SEC=$ReadyTimeoutSec
SUPERVISOR_ALLOW_UNLIMITED_RESTARTS=false
"@ | Set-Content -Path $envFile -Encoding UTF8
}
# Keep configuration readable only by administrators and the service account.
$acl = Get-Acl $envFile
$acl.SetAccessRuleProtection($true, $false)
$acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    $RunAs, "Read", "Allow"
)))
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
    "BUILTIN\Administrators", "FullControl", "Allow"
)))
Set-Acl -Path $envFile -AclObject $acl

$arguments = @(
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", "`"$Supervisor`"",
    "-WorkspaceDir", "`"$WorkspaceDir`"",
    "-MaxRestarts", "$MaxRestarts",
    "-ReadyTimeoutSec", "$ReadyTimeoutSec",
    "-EnvironmentFile", "`"$envFile`""
) -join " "
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $RunAs -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -RestartCount $MaxRestarts -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Agent Miki readiness-aware self-healing supervisor" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started scheduled task: $TaskName"
