@echo off
chcp 65001 >nul

echo.
echo ============================================
echo       停止 MyCC 后端服务
echo ============================================
echo.

echo 查找占用端口 18080 的进程...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":18080.*LISTENING"') do (
    set "PID=%%a"
    goto found
)

echo   端口 18080 未被占用，服务未运行
echo.
pause
exit /b 0

:found
echo   找到进程 PID: !PID!
echo   正在停止...
taskkill /PID !PID! /F >nul 2>&1

if !errorlevel! equ 0 (
    echo   ✅ 服务已停止
) else (
    echo   ❌ 停止失败，请手动执行: taskkill /F /PID !PID!
)

echo.
echo ============================================
echo.
timeout /t 2 /nobreak >nul
