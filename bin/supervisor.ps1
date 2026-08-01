#Requires -Version 5.1
<#
.SYNOPSIS
    Hiro Gateway Process Supervisor

.DESCRIPTION
    Monitors the Hiro gateway process and restarts it automatically on crash.
    Designed for unattended 24/7 operation on Windows.

    Usage:
        .\bin\supervisor.ps1
        .\bin\supervisor.ps1 -WorkspaceDir "D:\Data\My Agent\Agent\miki"
        .\bin\supervisor.ps1 -MaxRestarts 10   # limit restarts (0 = unbounded)

    Control files (all in WorkspaceDir\data\):
        SUPERVISOR_STOP     - create this file to stop the supervisor cleanly
        RESTART_EXHAUSTED   - written by supervisor when max restarts reached

    Environment variables (override defaults):
        SUPERVISOR_RESTART_DELAY_MS   Milliseconds to wait before restarting (default: 5000)
        SUPERVISOR_MAX_RESTARTS       Max restart attempts before giving up (0 = unbounded, default: 0)
        SUPERVISOR_WEBHOOK_URL        POST a JSON payload here on safe-mode / restart exhausted
        CORE_MAX_RESTARTS             Forwarded to gateway (0 = unbounded)
        LOG_LEVEL                     Forwarded to gateway

.PARAMETER WorkspaceDir
    Root workspace directory. Defaults to the parent of this script's bin/ folder.

.PARAMETER MaxRestarts
    Maximum number of times to restart the gateway before giving up.
    0 (default) means unbounded.
#>

param(
    [string]$WorkspaceDir = "",
    [int]$MaxRestarts = -1   # -1 = read from env or default 0 (unbounded)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Resolve paths ─────────────────────────────────────────────────────────────

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir  # miki/

if (-not $WorkspaceDir) {
    $WorkspaceDir = $RepoRoot
}

$DataDir    = Join-Path $WorkspaceDir "data"
$LogFile    = Join-Path $DataDir "supervisor.log"
$StopFile   = Join-Path $DataDir "SUPERVISOR_STOP"
$ExhFile    = Join-Path $DataDir "RESTART_EXHAUSTED"

# Ensure data directory exists
if (-not (Test-Path $DataDir)) {
    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
}

# ── Config ────────────────────────────────────────────────────────────────────

$RestartDelayMs = [int]($env:SUPERVISOR_RESTART_DELAY_MS ?? "5000")

if ($MaxRestarts -eq -1) {
    $MaxRestarts = [int]($env:SUPERVISOR_MAX_RESTARTS ?? "0")
}

$WebhookUrl = $env:SUPERVISOR_WEBHOOK_URL ?? ""

# The gateway entry point — adjust if your build output path differs
$GatewayEntry = Join-Path $RepoRoot "packages\gateway\dist\index.js"
if (-not (Test-Path $GatewayEntry)) {
    # Fallback: try the npm start script
    $GatewayEntry = ""
}

# ── Logging ───────────────────────────────────────────────────────────────────

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ss"
    $line = "[$ts] [$Level] $Message"
    Write-Host $line
    try { Add-Content -Path $LogFile -Value $line -Encoding UTF8 } catch {}
}

# ── Webhook notification ──────────────────────────────────────────────────────

function Send-Webhook {
    param([string]$Event, [string]$Detail = "")
    if (-not $WebhookUrl) { return }
    $payload = @{
        event     = $Event
        detail    = $Detail
        hostname  = $env:COMPUTERNAME
        timestamp = (Get-Date -Format o)
    } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Uri $WebhookUrl -Method Post -Body $payload `
            -ContentType "application/json" -TimeoutSec 10 -ErrorAction Stop
        Write-Log "Webhook delivered: $Event"
    } catch {
        Write-Log "Webhook failed: $_" "WARN"
    }
}

# ── Gateway launch ────────────────────────────────────────────────────────────

function Start-Gateway {
    # Forward relevant env vars to the gateway
    $env:Hiro_WORKSPACE_DIR = $WorkspaceDir
    $env:Hiro_RUNTIME_ROOT  = $RepoRoot
    if ($env:CORE_MAX_RESTARTS -eq $null) { $env:CORE_MAX_RESTARTS = "0" }

    if ($GatewayEntry) {
        Write-Log "Launching gateway: node $GatewayEntry"
        return Start-Process -FilePath "node" -ArgumentList $GatewayEntry `
            -WorkingDirectory $WorkspaceDir -PassThru -NoNewWindow
    } else {
        Write-Log "Launching gateway via: npm run start"
        return Start-Process -FilePath "npm" -ArgumentList "run","start" `
            -WorkingDirectory $RepoRoot -PassThru -NoNewWindow
    }
}

# ── Main supervisor loop ──────────────────────────────────────────────────────

Write-Log "=========================================="
Write-Log "Hiro Supervisor starting"
Write-Log "  WorkspaceDir  : $WorkspaceDir"
Write-Log "  MaxRestarts   : $(if ($MaxRestarts -eq 0) { 'unbounded' } else { $MaxRestarts })"
Write-Log "  RestartDelay  : ${RestartDelayMs}ms"
Write-Log "  WebhookUrl    : $(if ($WebhookUrl) { $WebhookUrl } else { '(none)' })"
Write-Log "=========================================="

# Remove stale control files from previous runs
if (Test-Path $StopFile) { Remove-Item $StopFile -Force }
if (Test-Path $ExhFile)  { Remove-Item $ExhFile  -Force }

$Restarts = 0
$GatewayProcess = $null

try {
    while ($true) {

        # Check for stop signal before launching
        if (Test-Path $StopFile) {
            Write-Log "SUPERVISOR_STOP file detected. Exiting supervisor cleanly."
            break
        }

        Write-Log "Starting gateway process (restart #$Restarts)..."
        try {
            $GatewayProcess = Start-Gateway
        } catch {
            Write-Log "Failed to launch gateway: $_" "ERROR"
            Start-Sleep -Milliseconds $RestartDelayMs
            continue
        }

        Write-Log "Gateway PID: $($GatewayProcess.Id)"

        # Wait for gateway to exit
        $GatewayProcess.WaitForExit()
        $ExitCode = $GatewayProcess.ExitCode
        Write-Log "Gateway exited with code $ExitCode" "WARN"

        # Check stop signal immediately after exit
        if (Test-Path $StopFile) {
            Write-Log "SUPERVISOR_STOP file detected. Not restarting."
            break
        }

        # Check restart limit
        $Restarts++
        if ($MaxRestarts -gt 0 -and $Restarts -ge $MaxRestarts) {
            $msg = "Gateway crashed $Restarts times — max restarts ($MaxRestarts) exhausted."
            Write-Log $msg "ERROR"
            Set-Content -Path $ExhFile -Value $msg -Encoding UTF8
            Send-Webhook -Event "restart_exhausted" -Detail $msg
            Write-Log "Wrote $ExhFile sentinel. Manual intervention required."
            break
        }

        $msg = "Restarting gateway in $($RestartDelayMs)ms (attempt $Restarts)..."
        Write-Log $msg "WARN"
        Send-Webhook -Event "gateway_crashed" -Detail "exit_code=$ExitCode restart_attempt=$Restarts"

        Start-Sleep -Milliseconds $RestartDelayMs
    }
} finally {
    # Ensure we don't leave a zombie gateway on supervisor exit
    if ($GatewayProcess -and -not $GatewayProcess.HasExited) {
        Write-Log "Stopping gateway (PID $($GatewayProcess.Id)) before supervisor exit..."
        try {
            taskkill /T /PID $GatewayProcess.Id /F 2>$null
        } catch {}
    }
    Write-Log "Supervisor exited."
}
