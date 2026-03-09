# MyCC Backend Stop Script

$PROJECT_DIR = $PSScriptRoot
$MYCC_DIR = "$PROJECT_DIR\.claude\skills\mycc"
$CONFIG_FILE = "$MYCC_DIR\current.json"

Write-Host ""
Write-Host "============================================" -ForegroundColor Red
Write-Host "       Stop MyCC Backend Service" -ForegroundColor Red
Write-Host "============================================" -ForegroundColor Red
Write-Host ""

$killedAny = $false

# 1. Kill process on port 18080 (node/tsx backend)
Write-Host "[1/3] Stopping backend (port 18080)..." -ForegroundColor Yellow
$portPids = Get-NetTCPConnection -LocalPort 18080 -ErrorAction SilentlyContinue |
            Where-Object State -eq "Listen" |
            Select-Object -ExpandProperty OwningProcess -ErrorAction SilentlyContinue

if ($portPids) {
    foreach ($procId in @($portPids)) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if ($proc) {
            Write-Host "  Killing PID $procId ($($proc.ProcessName))" -ForegroundColor Cyan
            Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
            $killedAny = $true
        }
    }
} else {
    Write-Host "  Port 18080 already free" -ForegroundColor Green
}

# 2. Kill cloudflared tunnel processes
Write-Host "[2/3] Stopping cloudflared tunnel..." -ForegroundColor Yellow
$cloudflaredProcs = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
if ($cloudflaredProcs) {
    foreach ($proc in $cloudflaredProcs) {
        Write-Host "  Killing cloudflared PID $($proc.Id)" -ForegroundColor Cyan
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        $killedAny = $true
    }
} else {
    Write-Host "  No cloudflared process found" -ForegroundColor Green
}

# 3. Clean up temp files and config
Write-Host "[3/3] Cleaning up..." -ForegroundColor Yellow
$filesToRemove = @(
    "$MYCC_DIR\start_hidden_temp.vbs",
    "$MYCC_DIR\start_backend_temp.bat",
    "$MYCC_DIR\backend.pid",
    $CONFIG_FILE
)
foreach ($f in $filesToRemove) {
    if (Test-Path $f) {
        Remove-Item $f -Force -ErrorAction SilentlyContinue
        Write-Host "  Removed: $(Split-Path $f -Leaf)" -ForegroundColor Gray
    }
}

Start-Sleep -Seconds 1

# Verify port is free
$stillListening = Get-NetTCPConnection -LocalPort 18080 -ErrorAction SilentlyContinue |
                  Where-Object State -eq "Listen"
if ($stillListening) {
    Write-Host "  Port still in use, trying taskkill fallback..." -ForegroundColor Yellow
    $netstatOutput = netstat -ano | findstr ":18080"
    $pidsToKill = $netstatOutput | ForEach-Object {
        if ($_ -match '\s+(\d+)$') { $matches[1] }
    } | Sort-Object -Unique
    foreach ($procId in $pidsToKill) {
        Write-Host "  taskkill /PID $procId /F" -ForegroundColor Cyan
        taskkill /PID $procId /F 2>&1 | Out-Null
    }
    Start-Sleep -Seconds 1
    $stillListening2 = Get-NetTCPConnection -LocalPort 18080 -ErrorAction SilentlyContinue |
                       Where-Object State -eq "Listen"
    if ($stillListening2) {
        Write-Host ""
        Write-Host "  ERROR: Port 18080 still occupied, please check manually" -ForegroundColor Red
    } else {
        Write-Host ""
        Write-Host "  All stopped OK (via taskkill)" -ForegroundColor Green
    }
} else {
    Write-Host ""
    Write-Host "  All stopped OK" -ForegroundColor Green
}

Write-Host ""
Write-Host "============================================" -ForegroundColor Red
Write-Host ""
