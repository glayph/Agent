#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$RepoRoot = "",
  [string]$WorkspaceDir = "",
  [string]$TaskName = "Agent Miki",
  [switch]$TaskDrill
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = (Resolve-Path (Join-Path $scriptDir "..\..")).Path } else { $RepoRoot = (Resolve-Path $RepoRoot).Path }
if ([string]::IsNullOrWhiteSpace($WorkspaceDir)) { $WorkspaceDir = $RepoRoot }
$WorkspaceDir = (New-Item -ItemType Directory -Force -Path $WorkspaceDir).FullName
$failures = 0
function Pass([string]$Message) { Write-Host "PASS  $Message" -ForegroundColor Green }
function Warn([string]$Message) { Write-Host "WARN  $Message" -ForegroundColor Yellow }
function Fail([string]$Message) { Write-Host "FAIL  $Message" -ForegroundColor Red; $script:failures++ }

try { $null = Get-Command node.exe -ErrorAction Stop; Pass "node is available" } catch { Fail "node.exe is missing" }
try { $null = Get-Command schtasks.exe -ErrorAction Stop; Pass "schtasks.exe is available" } catch { Fail "schtasks.exe is missing" }
foreach ($relative in @("scripts\miki-24-7.mjs", "bin\supervisor.ps1", "packages\gateway\dist\index.js")) {
  if (Test-Path (Join-Path $RepoRoot $relative)) { Pass "exists: $relative" } else { Fail "missing: $relative" }
}

$parseErrors = @()
$tokens = $null
foreach ($file in Get-ChildItem -Path (Join-Path $RepoRoot "deploy\windows") -Filter *.ps1 -File) {
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($file.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -gt 0) { $parseErrors += "$($file.Name): $($errors[0].Message)" }
}
if ($parseErrors.Count -eq 0) { Pass "deployment PowerShell files parse under Windows PowerShell" } else { $parseErrors | ForEach-Object { Fail $_ } }

$dataDir = Join-Path $WorkspaceDir "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$probe = Join-Path $dataDir (".host-validation-{0}" -f $PID)
try {
  Set-Content -Path $probe -Value (Get-Date -Format o) -Encoding UTF8
  Remove-Item $probe -Force
  Pass "workspace is writable"
} catch { Fail "workspace write failed: $($_.Exception.Message)" }

$drive = (Get-Item $WorkspaceDir).PSDrive
$freeMb = [math]::Floor($drive.Free / 1MB)
if ($freeMb -ge 512) { Pass "disk headroom ${freeMb}MB >= 512MB" } else { Fail "disk headroom ${freeMb}MB is below 512MB" }

if ($TaskDrill) {
  $path = "\AgentMiki\"
  $task = Get-ScheduledTask -TaskPath $path -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    Start-ScheduledTask -TaskPath $path -TaskName $TaskName
    Start-Sleep -Seconds 2
    $state = (Get-ScheduledTask -TaskPath $path -TaskName $TaskName).State
    if ($state -eq "Running") { Pass "Task Scheduler start/active drill" } else { Fail "task state is $state after start" }
    & (Join-Path $RepoRoot "deploy\windows\stop-task.ps1") -TaskName $TaskName -WorkspaceDir $WorkspaceDir
  } else { Fail "scheduled task is not registered" }
} else {
  Warn "Task Scheduler boot/restart/process-tree drill not run; rerun with -TaskDrill on target Windows host"
}
Warn "reboot recovery, native Windows llama.cpp, credentialed channels, firewall/TLS, and multi-hour soak require target-host evidence"
if ($failures -gt 0) { exit 1 }
