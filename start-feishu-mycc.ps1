# MyCC 后端启动脚本（带飞书通道）
#
# 自动配置飞书凭证并启动后端

# 设置编码
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# 加载 .env 文件
$ENV_FILE = "$PROJECT_DIR\.env"
if (Test-Path $ENV_FILE) {
    Get-Content $ENV_FILE | ForEach-Object {
        if (-not $_.Trim().StartsWith("#") -and $_.Trim() -ne "") {
            $parts = $_.Split("=", 2)
            if ($parts.Length -eq 2) {
                $key = $parts[0].Trim()
                $value = $parts[1].Trim()
                [Environment]::SetEnvironmentVariable($key, $value, "Process")
            }
        }
    }
} else {
    Write-Host "警告: .env 文件不存在，飞书通道可能无法工作" -ForegroundColor Yellow
    Write-Host "请从 .env.example 复制并配置飞书凭证" -ForegroundColor Gray
}

$PROJECT_DIR = "E:\AI\mycc\AImycc"
$SCRIPT_DIR = "$PROJECT_DIR\.claude\skills\mycc\scripts"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "       MyCC + 飞书通道" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# 显示飞书配置
Write-Host "[飞书配置]" -ForegroundColor Yellow
Write-Host "  App ID: $env:FEISHU_APP_ID" -ForegroundColor Gray
Write-Host "  企业 ID: ww6ce40c10b0b83871" -ForegroundColor Gray
Write-Host ""

# 启动后端
Write-Host "[启动] mycc 后端..." -ForegroundColor Yellow
Write-Host ""

Set-Location $SCRIPT_DIR
& node_modules/.bin/tsx src/index.ts start
