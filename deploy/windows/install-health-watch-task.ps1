[CmdletBinding()]
param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$TaskName = 'AgentMiki-HealthWatch',
  [string]$HealthUrl = 'http://127.0.0.1:18800/gateway/health',
  [string]$AlertFile = '',
  [switch]$NoStart
)
$ErrorActionPreference = 'Stop'
$Repo = (Resolve-Path $Repo).Path
if (-not $AlertFile) { $AlertFile = Join-Path $Repo 'data\alerts.jsonl' }
$script = Join-Path $Repo 'scripts\health-watch.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
if (-not (Test-Path $script -PathType Leaf)) { throw "Missing health watcher: $script" }
$dataDir = Join-Path $Repo 'data'
New-Item -ItemType Directory -Path $dataDir -Force | Out-Null
$wrapper = Join-Path $dataDir 'health-watch.cmd'
$lines = @(
  '@echo off',
  ('set "MIKI_HEALTH_URL={0}"' -f $HealthUrl.Replace('"', '')),
  ('set "MIKI_ALERT_FILE={0}"' -f $AlertFile.Replace('"', '')),
  ('"{0}" "{1}"' -f $node, $script)
)
Set-Content -Path $wrapper -Value $lines -Encoding ASCII
$action = New-ScheduledTaskAction -Execute $wrapper -WorkingDirectory $Repo
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Agent Miki health watcher'
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
if (-not $NoStart) { Start-ScheduledTask -TaskName $TaskName }
Write-Output ("Installed {0}; wrapper={1}; health={2}; alerts={3}" -f $TaskName, $wrapper, $HealthUrl, $AlertFile)
