#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$TaskName = "Agent Miki",
  [string]$WorkspaceDir = "",
  [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$taskPath = "\AgentMiki\"
if ([string]::IsNullOrWhiteSpace($WorkspaceDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $WorkspaceDir = (Resolve-Path (Join-Path $scriptDir "..\..")).Path
}
$dataDir = Join-Path $WorkspaceDir "data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
$stopFile = Join-Path $dataDir "SUPERVISOR_STOP"
Set-Content -Path $stopFile -Value (Get-Date -Format o) -Encoding UTF8

Stop-ScheduledTask -TaskPath $taskPath -TaskName $TaskName -ErrorAction SilentlyContinue
$deadline = (Get-Date).AddSeconds(30)
do {
  Start-Sleep -Milliseconds 500
  $task = Get-ScheduledTask -TaskPath $taskPath -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { break }
  $info = Get-ScheduledTaskInfo -TaskPath $taskPath -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $info -or $info.State -ne "Running") { break }
} while ((Get-Date) -lt $deadline)

if ($Unregister) {
  Unregister-ScheduledTask -TaskPath $taskPath -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}

# Defensive process-tree cleanup: only target the known supervisor command line.
$supervisors = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match "supervisor\.ps1" -and $_.CommandLine -match [regex]::Escape($WorkspaceDir) }
foreach ($proc in $supervisors) {
  & taskkill.exe /PID $proc.ProcessId /T /F | Out-Null
}

Remove-Item $stopFile -Force -ErrorAction SilentlyContinue
Write-Host "Stopped Agent Miki task '$TaskName'."
if ($Unregister) { Write-Host "Unregistered $taskPath$TaskName" }
