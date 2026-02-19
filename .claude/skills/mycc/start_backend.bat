@echo off
set CLOUDFLARED_PATH=C:\Users\wannago\AppData\Local\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe
cd /d "E:\AI\mycc\AImycc\.claude\skills\mycc\scripts"
npx tsx src/index.ts start >> "E:\AI\mycc\AImycc\.claude\skills\mycc\backend.log" 2>&1
