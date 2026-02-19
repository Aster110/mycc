# MyCC Backend Stop Script

$PROJECT_DIR = "E:\AI\mycc\AImycc"
$PID_FILE = "$PROJECT_DIR\.claude\skills\mycc\backend.pid"

Write-Host ""
Write-Host "============================================" -ForegroundColor Red
Write-Host "       Stop MyCC Backend Service" -ForegroundColor Red
Write-Host "============================================" -ForegroundColor Red
Write-Host ""

# Try to read PID from file first
$pidFromFile = $null
if (Test-Path $PID_FILE) {
    $pidFromFile = Get-Content $PID_FILE -Raw -ErrorAction SilentlyContinue
    if ($pidFromFile) {
        $pidFromFile = $pidFromFile.Trim()
    }
}

# Function to stop process by PID
function Stop-BackendProcess {
    param($processId, $source)
    try {
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process) {
            Write-Host "  Found process: $processId ($($process.ProcessName)) from $source" -ForegroundColor Cyan
            Write-Host "  Stopping..." -ForegroundColor Yellow
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 1

            # Check if still running
            $stillRunning = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if (-not $stillRunning) {
                Write-Host "  Service stopped successfully" -ForegroundColor Green

                # Remove PID file
                if (Test-Path $PID_FILE) {
                    Remove-Item $PID_FILE -Force -ErrorAction SilentlyContinue
                }
                return $true
            } else {
                Write-Host "  Failed to stop. Run: taskkill /F /PID $processId" -ForegroundColor Red
                return $false
            }
        }
    } catch {
        return $false
    }
    return $false
}

# 1. Try PID from file
$stopped = $false
if ($pidFromFile) {
    Write-Host "[1/2] Checking saved PID..." -ForegroundColor Yellow
    $stopped = Stop-BackendProcess -pid $pidFromFile -source "PID file"
}

# 2. Fallback to port check
if (-not $stopped) {
    Write-Host "[2/2] Checking port 18080..." -ForegroundColor Yellow
    $portProcess = Get-NetTCPConnection -LocalPort 18080 -ErrorAction SilentlyContinue |
                   Where-Object State -eq "Listen" |
                   Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue

    if ($portProcess) {
        $stopped = Stop-BackendProcess -pid $portProcess -source "port 18080"
    } else {
        Write-Host "  Port 18080 is free, service not running" -ForegroundColor Green
        $stopped = $true
    }
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Red
Write-Host ""

Start-Sleep -Seconds 2
