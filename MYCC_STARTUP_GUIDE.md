# MyCC 后端启动脚本使用说明

## 脚本列表

| 脚本 | 说明 |
|------|------|
| `start-mycc.bat` | 批处理启动脚本（双击运行） |
| `start-mycc.ps1` | PowerShell 启动脚本（功能更强大） |
| `stop-mycc.bat` | 批处理停止脚本 |
| `stop-mycc.ps1` | PowerShell 停止脚本 |

## 快速开始

### 方式一：双击运行 .bat 文件（最简单）

1. 双击 `start-mycc.bat`
2. 等待服务启动
3. 自动显示连接信息和配对码

### 方式二：PowerShell 脚本（推荐）

1. 右键点击 `start-mycc.ps1`
2. 选择「使用 PowerShell 运行」
3. 自动打开浏览器并显示连接信息

### 停止服务

- 双击 `stop-mycc.bat` 或 `stop-mycc.ps1`

## 自动启动（开机自启）

### Windows 任务计划程序

1. 打开「任务计划程序」（Win+R 输入 `taskschd.msc`）
2. 右侧点击「创建基本任务」
3. 名称：`MyCC Backend`
4. 触发器：选择「当计算机启动时」
5. 操作：选择「启动程序」
   - 程序：`powershell.exe`
   - 参数：`-ExecutionPolicy Bypass -File "E:\AI\mycc\AImycc\start-mycc.ps1"`
6. 完成创建

### 开机自启文件夹

1. 按 `Win + R` 输入 `shell:startup`
2. 创建 `start-mycc.bat` 的快捷方式
3. 复制到启动文件夹

## 手动管理

### 查看服务状态
```batch
netstat -ano | findstr :18080
```

### 查看实时日志
```batch
type E:\AI\mycc\AImycc\.claude\skills\mycc\backend.log
```

### 手动停止服务
```batch
netstat -ano | findstr :18080
taskkill /PID <PID> /F
```

## 连接信息位置

服务启动后，连接信息保存在：
```
E:\AI\mycc\AImycc\.claude\skills\mycc\current.json
```

包含：
- `mpUrl`: 小程序访问 URL
- `routeToken`: 连接码
- `pairCode`: 配对码
- `tunnelUrl`: Cloudflare Tunnel URL

## 故障排查

### 端口被占用
```batch
# 查找占用进程
netstat -ano | findstr :18080

# 停止进程
taskkill /PID <PID> /F
```

### cloudflared 未找到
检查环境变量是否正确设置：
```batch
echo %CLOUDFLARED_PATH%
```

### 服务启动失败
查看日志：
```batch
type E:\AI\mycc\AImycc\.claude\skills\mycc\backend.log
```

## 注意事项

- **VPN/代理**：cloudflared 需要访问外网，确保全程开启
- **防火墙**：首次运行可能需要允许防火墙访问
- **后台运行**：关闭窗口后服务继续运行
- **重启电脑**：服务会停止，需要重新启动（或设置开机自启）
