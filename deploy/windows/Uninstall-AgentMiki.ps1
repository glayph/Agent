<#
.SYNOPSIS
    Safely remove the Agent Miki scheduled task.

.DESCRIPTION
    Stops and unregisters the task created by Install-AgentMiki.ps1. Runtime
    data is preserved by default; -RemoveData is an explicit destructive
    operation. Provider credentials are not read or printed.
#>

[CmdletBinding()]
param(
    [string]$TaskName = "Agent-Miki",
    [string]$WorkspaceDir = "",
    [switch]$RemoveData,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $WorkspaceDir) {
    $scriptRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
    $WorkspaceDir = $scriptRoot
}
$WorkspaceDir = [IO.Path]::GetFullPath($WorkspaceDir)

Write-Host "Task name : $TaskName"
Write-Host "Workspace : $WorkspaceDir"
Write-Host "Data mode : $(if ($RemoveData) { 'remove (explicit)' } else { 'preserve' })"

if ($DryRun) {
    Write-Host "Dry run passed. No task or files were changed."
    exit 0
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator
)) {
    throw "Run the uninstaller from an elevated PowerShell session."
}

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task: $TaskName"
} else {
    Write-Host "Scheduled task was not registered: $TaskName"
}

if ($RemoveData) {
    $dataDir = Join-Path $WorkspaceDir "data"
    if (Test-Path $dataDir) {
        Remove-Item -LiteralPath $dataDir -Recurse -Force
        Write-Host "Removed runtime data: $dataDir"
    }
} else {
    Write-Host "Runtime data preserved."
}
