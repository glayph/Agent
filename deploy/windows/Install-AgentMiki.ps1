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
    [string]$NodeExecutable = "",
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
if (-not $NodeExecutable) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodeExecutable = $nodeCommand.Source }
}
if (-not $NodeExecutable -or -not (Test-Path $NodeExecutable)) {
    throw "Node executable not found; pass -NodeExecutable with an absolute path or install Node.js system-wide."
}
$requiredArtifacts = @(
    "packages\gateway\dist\index.js",
    "packages\core\dist\api\index.js",
    "packages\config\dist\index.js",
    "packages\installer\dist\index.js",
    "packages\skills\dist\index.js",
    "packages\ui\frontend\dist\index.html"
)
foreach ($artifact in $requiredArtifacts) {
    if (-not (Test-Path (Join-Path $RepoRoot $artifact))) {
        throw "Missing build artifact: $(Join-Path $RepoRoot $artifact). Run npm run build:all first."
    }
}
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
    Write-Host "Node executable : $NodeExecutable"
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

$workspaceData = Join-Path $WorkspaceDir "data"
New-Item -ItemType Directory -Path $workspaceData -Force | Out-Null
$envDir = Join-Path $WorkspaceDir "config"
New-Item -ItemType Directory -Path $envDir -Force | Out-Null
$workspaceIdentity = Join-Path $WorkspaceDir "identity"
New-Item -ItemType Directory -Path $workspaceIdentity -Force | Out-Null

# Seed persistent runtime files from the application only when the owner has not
# already supplied them. The gateway reads MIKI_CONFIG_DIR and identity files
# from MIKI_WORKSPACE_DIR; a separate workspace must not silently lose autonomy
# settings or the heartbeat checklist.
foreach ($name in @("agent.yaml", "tools.yaml")) {
    $source = Join-Path (Join-Path $RepoRoot "config") $name
    $destination = Join-Path $envDir $name
    if ((Test-Path $source) -and -not (Test-Path $destination)) {
        Copy-Item -LiteralPath $source -Destination $destination
    }
}
$sourceIdentity = Join-Path $RepoRoot "identity"
if (Test-Path $sourceIdentity) {
    Get-ChildItem -LiteralPath $sourceIdentity -File -Recurse -Force | ForEach-Object {
        $relative = $_.FullName.Substring($sourceIdentity.Length).TrimStart([char]92, [char]47)
        $destination = Join-Path $workspaceIdentity $relative
        if (-not (Test-Path $destination)) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
            Copy-Item -LiteralPath $_.FullName -Destination $destination
        }
    }
}

$envFile = Join-Path $envDir "agent-miki.env"
if (-not (Test-Path $envFile)) {
    @"
MIKI_SOURCE_ROOT=$RepoRoot
MIKI_RUNTIME_ROOT=$RepoRoot
MIKI_NODE=$NodeExecutable
MIKI_WORKSPACE_DIR=$WorkspaceDir
MIKI_CONFIG_DIR=$envDir
MIKI_DATA_DIR=$workspaceData
GATEWAY_PORT=18800
SUPERVISOR_MAX_RESTARTS=$MaxRestarts
SUPERVISOR_READY_TIMEOUT_SEC=$ReadyTimeoutSec
SUPERVISOR_ALLOW_UNLIMITED_RESTARTS=true
"@ | Set-Content -Path $envFile -Encoding UTF8
} else {
    $existingEnvironment = Get-Content -Path $envFile
    if (-not ($existingEnvironment -match '^MIKI_SOURCE_ROOT=')) { Add-Content -Path $envFile -Value "MIKI_SOURCE_ROOT=$RepoRoot" }
    if (-not ($existingEnvironment -match '^MIKI_WORKSPACE_DIR=')) { Add-Content -Path $envFile -Value "MIKI_WORKSPACE_DIR=$WorkspaceDir" }
    if (-not ($existingEnvironment -match '^MIKI_RUNTIME_ROOT=')) { Add-Content -Path $envFile -Value "MIKI_RUNTIME_ROOT=$RepoRoot" }
    if (-not ($existingEnvironment -match '^MIKI_CONFIG_DIR=')) { Add-Content -Path $envFile -Value "MIKI_CONFIG_DIR=$envDir" }
    if (-not ($existingEnvironment -match '^MIKI_DATA_DIR=')) { Add-Content -Path $envFile -Value "MIKI_DATA_DIR=$workspaceData" }
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
    "-EnvironmentFile", "`"$envFile`"",
    "-NodeExecutable", "`"$NodeExecutable`""
) -join " "
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments -WorkingDirectory $RepoRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId $RunAs -LogonType ServiceAccount -RunLevel Limited
# Windows accepts at most 999 scheduler restarts. Agent Miki is meant to keep running, so the scheduler retries the
# supervisor for as long as the machine is up; the supervisor itself never stops restarting the gateway.
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description "Agent Miki readiness-aware self-healing supervisor" -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed and started scheduled task: $TaskName"
