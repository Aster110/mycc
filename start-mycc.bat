@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion

echo.
echo ============================================
echo       MyCC 后端一键启动脚本
echo ============================================
echo.

REM 设置 cloudflared 路径
set "CLOUDFLARED_PATH=C:\Users\wannago\AppData\Local\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe"

REM 项目目录
set "PROJECT_DIR=E:\AI\mycc\AImycc"
set "SCRIPT_DIR=%PROJECT_DIR%\.claude\skills\mycc\scripts"

REM 进入脚本目录
cd /d "%SCRIPT_DIR%"

REM 检查端口占用
echo [1/3] 检查端口 18080...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":18080.*LISTENING"') do (
    echo   端口已被占用 (PID: %%a)，正在关闭...
    taskkill /PID %%a /F >nul 2>&1
    timeout /t 2 >nul
)
echo   端口 18080 可用
echo.

REM 启动后端服务
echo [2/3] 启动 MyCC 后端服务...
echo   加载飞书配置...

REM 读取 .env 文件并设置环境变量
if exist "%PROJECT_DIR%\.env" (
    for /f "usebackq tokens=1,2 delims==" %%a in ("%PROJECT_DIR%\.env") do (
        REM 跳过注释和空行
        echo %%a | findstr /r "^#" >nul
        if errorlevel 1 (
            REM 跳过空行
            if not "%%a"=="" (
                set "%%a=%%b"
            )
        )
    )
    echo   飞书配置已加载
)

start /B "" cmd /c "set CLOUDFLARED_PATH=%CLOUDFLARED_PATH% && set FEISHU_APP_ID=%FEISHU_APP_ID% && set FEISHU_APP_SECRET=%FEISHU_APP_SECRET% && set FEISHU_RECEIVE_USER_ID=%FEISHU_RECEIVE_USER_ID% && set FEISHU_RECEIVE_ID_TYPE=%FEISHU_RECEIVE_ID_TYPE% && set FEISHU_CONNECTION_MODE=%FEISHU_CONNECTION_MODE% && set FEISHU_SHOW_TOOL_USE=%FEISHU_SHOW_TOOL_USE% && npx tsx src/index.ts start > \"%PROJECT_DIR%\.claude\skills\mycc\backend.log\" 2>&1"

REM 等待服务启动
echo   等待服务启动...
timeout /t 8 /nobreak >nul

REM 读取并显示连接信息
echo [3/3] 读取连接信息...
echo.

REM 等待文件生成
set "MAX_WAIT=30"
set "WAIT_COUNT=0"
:waitloop
if exist "%PROJECT_DIR%\.claude\skills\mycc\current.json" goto showinfo
set /a WAIT_COUNT+=1
if !WAIT_COUNT! geq %MAX_WAIT% (
    echo   超时：连接信息文件未生成
    echo   请查看日志: type "%PROJECT_DIR%\.claude\skills\mycc\backend.log"
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
goto waitloop

:showinfo
echo.
echo ============================================
echo           连接信息
echo ============================================
echo.

REM 解析 JSON 并显示
for /f "tokens=1,2 delims=:," %%a in ('type "%PROJECT_DIR%\.claude\skills\mycc\current.json" ^| findstr /C:"mpUrl" /C:"routeToken" /C:"pairCode" /C:"tunnelUrl"') do (
    set "line=%%a:%%b"
    set "line=!line:"=!"
    set "line=!line: =!"
    set "key=!line::=!"
    set "value=!line::= ~!"

    if "!key!"=="mpUrl" echo   小程序 URL: !value!
    if "!key!"=="routeToken" echo   连接码: !value!
    if "!key!"=="pairCode" echo   配对码: !value!
    if "!key!"=="tunnelUrl" echo   Tunnel URL: !value!
)

echo.
echo ============================================
echo.
echo   后端服务已在后台运行
echo   日志文件: %PROJECT_DIR%\.claude\skills\mycc\backend.log
echo.
echo   按任意键关闭此窗口（服务将继续运行）
echo   或按 Ctrl+C 停止服务
echo.
pause >nul

REM 如果用户想停止服务，取消下面的注释
REM taskkill /F /IM node.exe /FI "WINDOWTITLE eq npx*"
