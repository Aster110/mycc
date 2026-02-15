# MyCC Backend One-Click Startup Script
# Right-click -> Run with PowerShell

# Set encoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Configuration
$PROJECT_DIR = "E:\AI\mycc\AImycc"
$SCRIPT_DIR = "$PROJECT_DIR\.claude\skills\mycc\scripts"
$LOG_FILE = "$PROJECT_DIR\.claude\skills\mycc\backend.log"
$CONFIG_FILE = "$PROJECT_DIR\.claude\skills\mycc\current.json"
$TSX_BIN = "$SCRIPT_DIR\node_modules\.bin\tsx"

Clear-Host

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "       MyCC Backend v0.5.1" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Check dependencies
Write-Host "[1/4] Checking dependencies..." -ForegroundColor Yellow

if (-not (Test-Path $TSX_BIN)) {
    Write-Host "  ERROR: tsx not found!" -ForegroundColor Red
    Write-Host "  Run: cd $SCRIPT_DIR && npm install" -ForegroundColor Gray
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host "  tsx: OK" -ForegroundColor Green

$claudeCmd = Get-Command claude -ErrorAction SilentlyContinue
if (-not $claudeCmd) {
    Write-Host "  WARNING: Claude Code CLI not found in PATH" -ForegroundColor Yellow
} else {
    Write-Host "  Claude Code: OK" -ForegroundColor Green
}

$cloudflaredCmd = Get-Command cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflaredCmd) {
    Write-Host "  WARNING: cloudflared not found in PATH" -ForegroundColor Yellow
} else {
    Write-Host "  cloudflared: OK" -ForegroundColor Green
}

Write-Host ""

# Check and stop existing process
Write-Host "[2/4] Checking port 8080..." -ForegroundColor Yellow
$existingProcess = Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue |
                    Where-Object State -eq "Listen" |
                    Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue

if ($existingProcess) {
    Write-Host "  Port occupied (PID: $existingProcess), stopping..." -ForegroundColor Red
    Stop-Process -Id $existingProcess -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
Write-Host "  Port 8080 available" -ForegroundColor Green
Write-Host ""

# Start backend
Write-Host "[3/4] Starting backend..." -ForegroundColor Yellow

# Clear old log
if (Test-Path $LOG_FILE) { Remove-Item $LOG_FILE -Force }

# Start in background using PowerShell job
$scriptBlock = {
    param($tsx, $scriptDir, $logFile)
    Set-Location $scriptDir
    & $tsx "src/index.ts" "start" >> $logFile 2>&1
}

Start-Job -ScriptBlock $scriptBlock -ArgumentList $TSX_BIN, $SCRIPT_DIR, $LOG_FILE -Name "mycc-backend" | Out-Null

# Wait for process to start
Start-Sleep -Seconds 3

# Check if port 8080 is now listening
$portProcess = Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue |
               Where-Object State -eq "Listen" |
               Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue

if ($portProcess) {
    Write-Host "  Backend started (PID: $portProcess)" -ForegroundColor Green
} else {
    Write-Host "  WARNING: Port 8080 not listening yet" -ForegroundColor Yellow
}

Write-Host ""

# Wait for config file
Write-Host "[4/4] Waiting for service ready..." -ForegroundColor Yellow
$timeout = 45
$elapsed = 0
while ($elapsed -lt $timeout) {
    if (Test-Path $CONFIG_FILE) {
        try {
            $config = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json
            if ($config.routeToken -and $config.pairCode -and $config.tunnelUrl) {
                break
            }
        } catch {
            # Config not ready yet
        }
    }
    Start-Sleep -Seconds 1
    $elapsed++
    Write-Host "  Waiting... ($elapsed/$timeout sec)" -NoNewline
    Write-Host "`r" -NoNewline
}

Write-Host ""

# Check if started successfully
if (-not (Test-Path $CONFIG_FILE)) {
    Write-Host ""
    Write-Host "  ERROR: Startup timeout!" -ForegroundColor Red
    Write-Host "  Check log: Get-Content '$LOG_FILE' -Tail 50" -ForegroundColor Gray
    Write-Host ""
    Read-Host "Press Enter to exit"
    exit 1
}

# Read connection info
$config = Get-Content $CONFIG_FILE -Raw | ConvertFrom-Json

# Display connection info
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "           Service Started!" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "+------------------------------------------+" -ForegroundColor White
Write-Host "|  Connect from your phone:                |" -ForegroundColor White
Write-Host "+------------------------------------------+" -ForegroundColor White
Write-Host ("|  MiniApp URL: " + $config.mpUrl) -ForegroundColor Cyan
Write-Host ("|  Route Token: " + $config.routeToken) -ForegroundColor Yellow
Write-Host ("|  Pair Code:    " + $config.pairCode) -ForegroundColor Yellow
Write-Host ("|  Tunnel:       " + $config.tunnelUrl.Substring(0, [Math]::Min(50, $config.tunnelUrl.Length))) -ForegroundColor Gray
if ($config.tunnelUrl.Length -gt 50) {
    Write-Host ("|                 " + $config.tunnelUrl.Substring(50)) -ForegroundColor Gray
}
Write-Host "+------------------------------------------+" -ForegroundColor White
Write-Host ""

# Open browser
Write-Host "Opening browser..." -ForegroundColor Gray
try {
    Start-Process $config.mpUrl
} catch {
    Write-Host "  Failed to open browser" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Commands:" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  View logs (live):" -ForegroundColor Gray
Write-Host "    Get-Content '$LOG_FILE' -Wait" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Stop service:" -ForegroundColor Gray
Write-Host "    .\stop-mycc.ps1" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Or kill by port:" -ForegroundColor Gray
Write-Host "    netstat -ano | findstr :8080" -ForegroundColor DarkGray
Write-Host "    taskkill /PID <pid> /F" -ForegroundColor DarkGray
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Show initial logs
Write-Host "Showing initial logs (will exit in 30s)..." -ForegroundColor DarkYellow
Write-Host ""

$timeoutEnd = (Get-Date).AddSeconds(30)
$lastLines = @()
do {
    if (Test-Path $LOG_FILE) {
        $currentLines = Get-Content $LOG_FILE -ErrorAction SilentlyContinue
        if ($currentLines.Count -gt $lastLines.Count) {
            $newLines = $currentLines[$lastLines.Count..($currentLines.Count - 1)]
            $newLines | ForEach-Object { Write-Host $_ }
            $lastLines = $currentLines
        }
    }
    Start-Sleep -Seconds 1
} while ((Get-Date) -lt $timeoutEnd)

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Startup script exiting..." -ForegroundColor Green
Write-Host "  Backend continues running in background" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
