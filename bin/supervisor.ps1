<#
.SYNOPSIS
    Agent Miki Windows service supervisor.

.DESCRIPTION
    Starts the built gateway, waits for its health endpoint, monitors the
    complete child process tree, and enters a failed/manual-intervention state
    after the bounded restart budget is exhausted. Unlimited restarts require
    an explicit environment override and are never the default.

    This script can run directly or under Windows Task Scheduler/Service.
    It does not contain provider credentials.
#>

param(
    [string]$WorkspaceDir = "",
    [int]$MaxRestarts = -1,
    [int]$ReadyTimeoutSec = -1,
    [int]$RestartDelayMs = -1,
    [int]$RestartResetAfterSec = -1,
    [string]$EnvironmentFile = "",
    [string]$NodeExecutable = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $EnvironmentFile) { $EnvironmentFile = $env:MIKI_ENV_FILE }
if ($EnvironmentFile -and (Test-Path $EnvironmentFile)) {
    foreach ($line in Get-Content -Path $EnvironmentFile) {
        if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$' -and $line -notmatch '^\s*#') {
            [Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Split-Path -Parent $ScriptDir
if (-not $WorkspaceDir) { $WorkspaceDir = $RepoRoot }
$WorkspaceDir = [IO.Path]::GetFullPath($WorkspaceDir)

$DataDir = Join-Path $WorkspaceDir "data"
$LogFile = Join-Path $DataDir "supervisor.log"
$StopFile = Join-Path $DataDir "SUPERVISOR_STOP"
$ExhaustedFile = Join-Path $DataDir "RESTART_EXHAUSTED"
$GatewayPort = [int]($env:GATEWAY_PORT ?? "18800")
if (-not $NodeExecutable) { $NodeExecutable = $env:MIKI_NODE }
if (-not $NodeExecutable) {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $NodeExecutable = $nodeCommand.Source }
}
if (-not $NodeExecutable -or -not (Test-Path $NodeExecutable)) {
    throw "Node executable not found; set MIKI_NODE or pass -NodeExecutable with an absolute path."
}
$GatewayEntry = $env:MIKI_GATEWAY_ENTRY
if (-not $GatewayEntry) {
    $GatewayEntry = Join-Path $RepoRoot "packages\gateway\dist\index.js"
}

if ($MaxRestarts -eq -1) {
    $MaxRestarts = [int]($env:SUPERVISOR_MAX_RESTARTS ?? "5")
}
if ($ReadyTimeoutSec -eq -1) {
    $ReadyTimeoutSec = [int]($env:SUPERVISOR_READY_TIMEOUT_SEC ?? "45")
}
if ($RestartDelayMs -eq -1) {
    $RestartDelayMs = [int]($env:SUPERVISOR_RESTART_DELAY_MS ?? "5000")
}
if ($RestartResetAfterSec -eq -1) {
    $RestartResetAfterSec = [int]($env:SUPERVISOR_RESTART_RESET_AFTER_SEC ?? "300")
}

$AllowUnlimited = (($env:SUPERVISOR_ALLOW_UNLIMITED_RESTARTS ?? "false") -eq "true")
if ($MaxRestarts -le 0 -and -not $AllowUnlimited) { $MaxRestarts = 5 }
if ($ReadyTimeoutSec -lt 5) { $ReadyTimeoutSec = 45 }
if ($RestartDelayMs -lt 1000) { $RestartDelayMs = 5000 }
if ($RestartResetAfterSec -lt 30) { $RestartResetAfterSec = 300 }

if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssK"
    $line = "[$ts] [$Level] $Message"
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch { }
}

function Send-Webhook {
    param([string]$Event, [string]$Detail = "")
    $url = $env:SUPERVISOR_WEBHOOK_URL
    if (-not $url) { return }
    $payload = @{
        event = $Event
        detail = $Detail
        hostname = $env:COMPUTERNAME
        timestamp = (Get-Date -Format o)
    } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Uri $url -Method Post -Body $payload `
            -ContentType "application/json" -TimeoutSec 10 -ErrorAction Stop | Out-Null
        Write-Log "Webhook delivered: $Event"
    } catch {
        Write-Log "Webhook delivery failed for $Event" "WARN"
    }
}

function Stop-Gateway {
    param([object]$Process)
    if (-not $Process) { return }
    try {
        if (-not $Process.HasExited) {
            Write-Log "Stopping gateway process tree (PID $($Process.Id))" "WARN"
            & taskkill.exe /T /F /PID $Process.Id 2>$null | Out-Null
        }
    } catch {
        Write-Log "Gateway process-tree cleanup failed" "WARN"
    }
}

function Start-Gateway {
    $env:MIKI_WORKSPACE_DIR = $WorkspaceDir
    $env:MIKI_RUNTIME_ROOT = $RepoRoot
    $env:MIKI_24_7_RUNTIME = "1"
    if (-not $env:CORE_MAX_RESTARTS) { $env:CORE_MAX_RESTARTS = "5" }

    if (Test-Path $GatewayEntry) {
        Write-Log "Launching gateway from built entry"
        return Start-Process -FilePath $NodeExecutable -ArgumentList @($GatewayEntry) `
            -WorkingDirectory $RepoRoot -PassThru -NoNewWindow
    }

    $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
    if (-not $npm) { throw "Gateway build not found and npm.cmd is unavailable" }
    Write-Log "Launching gateway through npm fallback" "WARN"
    return Start-Process -FilePath $npm.Source -ArgumentList @("run", "start") `
        -WorkingDirectory $RepoRoot -PassThru -NoNewWindow
}

function Wait-ForGatewayReady {
    param([object]$Process)
    $deadline = (Get-Date).AddSeconds($ReadyTimeoutSec)
    $lastError = "not reachable"
    while ((Get-Date) -lt $deadline) {
        if ($Process.HasExited) {
            $lastError = "gateway exited with code $($Process.ExitCode)"
            break
        }
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/gateway/health" `
                -TimeoutSec 2 -ErrorAction Stop
            if ($health.ok -eq $true -or $null -ne $health) {
                return $true
            }
            $lastError = "health response was not ready"
        } catch {
            $lastError = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 500
    }
    Write-Log "Gateway readiness timeout after ${ReadyTimeoutSec}s: $lastError" "ERROR"
    return $false
}

Write-Log "=========================================="
Write-Log "Agent Miki Windows supervisor starting"
Write-Log "  WorkspaceDir       : $WorkspaceDir"
Write-Log "  GatewayPort        : $GatewayPort"
Write-Log "  MaxRestarts        : $(if ($AllowUnlimited) { 'unlimited (explicit override)' } else { $MaxRestarts })"
Write-Log "  ReadyTimeout       : ${ReadyTimeoutSec}s"
Write-Log "  RestartDelay       : ${RestartDelayMs}ms"
Write-Log "  RestartResetAfter  : ${RestartResetAfterSec}s"
Write-Log "=========================================="

if (Test-Path $StopFile) { Remove-Item $StopFile -Force }
if (Test-Path $ExhaustedFile) { Remove-Item $ExhaustedFile -Force }

$RestartCount = 0
$GatewayProcess = $null
$StopRequested = $false

try {
    while (-not $StopRequested) {
        if (Test-Path $StopFile) {
            Write-Log "SUPERVISOR_STOP detected before launch"
            break
        }

        Write-Log "Starting gateway (restart count $RestartCount)"
        try {
            $GatewayProcess = Start-Gateway
            Write-Log "Gateway PID: $($GatewayProcess.Id)"
        } catch {
            $RestartCount++
            Write-Log "Gateway launch failed: $($_.Exception.Message)" "ERROR"
            if (-not $AllowUnlimited -and $RestartCount -gt $MaxRestarts) { break }
            Start-Sleep -Milliseconds $RestartDelayMs
            continue
        }

        if (-not (Wait-ForGatewayReady -Process $GatewayProcess)) {
            Stop-Gateway -Process $GatewayProcess
            $ExitCode = -1
        } else {
            Write-Log "Gateway readiness confirmed"
            $HealthySince = Get-Date
            while (-not $GatewayProcess.HasExited) {
                if (Test-Path $StopFile) {
                    Write-Log "SUPERVISOR_STOP detected; shutting down cleanly"
                    $StopRequested = $true
                    Stop-Gateway -Process $GatewayProcess
                    break
                }
                if (((Get-Date) - $HealthySince).TotalSeconds -ge $RestartResetAfterSec -and $RestartCount -gt 0) {
                    $RestartCount = 0
                    $HealthySince = Get-Date
                    Write-Log "Stable gateway window reached; restart budget reset"
                }
                Start-Sleep -Seconds 1
            }
            $ExitCode = if ($GatewayProcess.HasExited) { $GatewayProcess.ExitCode } else { 0 }
        }

        if ($StopRequested) { break }
        $RestartCount++
        Write-Log "Gateway exited with code $ExitCode (restart count $RestartCount)" "WARN"
        if (-not $AllowUnlimited -and $RestartCount -gt $MaxRestarts) {
            $message = "Gateway restart budget exhausted after $RestartCount failures. Manual intervention required."
            Write-Log $message "ERROR"
            Set-Content -Path $ExhaustedFile -Value $message -Encoding UTF8
            Send-Webhook -Event "restart_exhausted" -Detail $message
            break
        }

        $Delay = [Math]::Min(60000, $RestartDelayMs * [Math]::Pow(2, [Math]::Min($RestartCount - 1, 6)))
        $Delay = [int]$Delay
        Write-Log "Restarting gateway in ${Delay}ms"
        Send-Webhook -Event "gateway_crashed" -Detail "exit_code=$ExitCode restart_count=$RestartCount"
        Start-Sleep -Milliseconds $Delay
    }
} finally {
    Stop-Gateway -Process $GatewayProcess
    Write-Log "Supervisor exited"
}

if (Test-Path $ExhaustedFile) { exit 1 }
exit 0
