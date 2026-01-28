#!/usr/bin/env node
"use strict";
/**
 * CC 小程序本地后端
 *
 * 用法:
 *   cc-mp start [--cwd <工作目录>]
 *   cc-mp status
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const nanoid_1 = require("nanoid");
const https_1 = __importDefault(require("https"));
const fs_2 = __importDefault(require("fs"));
// 只用大写字母+数字，方便输入
const generateCode = (0, nanoid_1.customAlphabet)("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 6);
const qrcode_terminal_1 = __importDefault(require("qrcode-terminal"));
const chalk_1 = __importDefault(require("chalk"));
const http_server_js_1 = require("./http-server.js");
const cc_bridge_js_1 = require("./cc-bridge.js");
const PORT = process.env.PORT || 8080;
// 检查是否为 Windows 系统
function isWindows() {
    return process.platform === "win32";
}
// 杀掉占用端口的旧进程
function killExistingProcess(port) {
    try {
        let pid = null;
        if (isWindows()) {
            // Windows 方式：使用 netstat 查找 PID
            try {
                const output = (0, child_process_1.execSync)(`netstat -ano | findstr ":${port}"`).toString();
                const lines = output.split('\n');
                for (const line of lines) {
                    // 匹配格式: "  TCP    0.0.0.0:8080           0.0.0.0:0              LISTENING       21068"
                    const match = line.match(/LISTENING\s+(\d+)/);
                    if (match) {
                        pid = match[1].trim();
                        break;
                    }
                }
            }
            catch {
                // 没有进程占用端口，忽略
            }
        }
        else {
            // Unix/Linux 方式：使用 lsof
            pid = (0, child_process_1.execSync)(`lsof -i :${port} -t 2>/dev/null`).toString().trim();
        }
        if (pid) {
            console.log(chalk_1.default.yellow(`发现端口 ${port} 被占用 (PID: ${pid})，正在关闭旧进程...`));
            if (isWindows()) {
                try {
                    // 方法1：使用 taskkill
                    (0, child_process_1.execSync)(`taskkill /F /PID ${pid} 2>nul`);
                }
                catch {
                    // 方法2：使用 PowerShell 作为备选
                    try {
                        (0, child_process_1.execSync)(`powershell -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`);
                    }
                    catch {
                        console.log(chalk_1.default.yellow(`警告: 无法停止进程 ${pid}，可能已退出或无权限`));
                    }
                }
                // Windows 等待（正确语法）
                try {
                    (0, child_process_1.execSync)("timeout /t 1 /nobreak > nul 2>&1");
                }
                catch {
                    // timeout 命令可能失败，使用 ping 作为替代等待
                    (0, child_process_1.execSync)("ping -n 2 127.0.0.1 > nul");
                }
            }
            else {
                (0, child_process_1.execSync)(`kill ${pid} 2>/dev/null`);
                // Unix 等待
                (0, child_process_1.execSync)("sleep 0.5");
            }
            console.log(chalk_1.default.green("✓ 旧进程已关闭\n"));
        }
    }
    catch {
        // 没有进程占用端口，忽略
    }
}
const WORKER_URL = process.env.WORKER_URL || "https://api.mycc.dev";
const PACKAGE_NAME = "mycc-backend";
/**
 * 自动查找项目根目录
 * 从当前目录向上查找，直到找到包含 .claude/ 或 claude.md (不区分大小写) 的目录
 */
function findProjectRoot(startDir) {
    let current = startDir;
    const root = "/";
    while (current !== root) {
        // 检查是否包含 .claude 目录
        if ((0, fs_1.existsSync)((0, path_1.join)(current, ".claude"))) {
            return current;
        }
        // 检查是否包含 claude.md（不区分大小写）
        try {
            const files = (0, fs_1.readdirSync)(current);
            const hasClaudeMd = files.some(f => f.toLowerCase() === "claude.md");
            if (hasClaudeMd) {
                return current;
            }
        }
        catch {
            // 读取目录失败，跳过
        }
        // 向上一级
        const parent = (0, path_1.join)(current, "..");
        if (parent === current)
            break;
        current = parent;
    }
    return null;
}
// 检测版本更新
async function checkVersionUpdate() {
    try {
        // 获取本地版本
        const packageJson = await import("../package.json", { with: { type: "json" } });
        const localVersion = packageJson.default.version;
        // 获取最新版本（静默失败，不阻塞启动）
        const stderrRedirect = isWindows() ? "2>nul" : "2>/dev/null";
        const latestVersion = (0, child_process_1.execSync)(`npm show ${PACKAGE_NAME} version ${stderrRedirect}`, { timeout: 5000 })
            .toString()
            .trim();
        if (latestVersion && latestVersion !== localVersion) {
            console.log(chalk_1.default.yellow(`\n⚠️  发现新版本 ${latestVersion}（当前 ${localVersion}）`));
            console.log(chalk_1.default.yellow(`   运行 npm update -g ${PACKAGE_NAME} 更新\n`));
        }
    }
    catch {
        // 版本检测失败，静默忽略（可能未发布到 npm 或网络问题）
    }
}
async function main() {
    const args = process.argv.slice(2);
    const command = args[0] || "start";
    switch (command) {
        case "start":
            await startServer(args);
            break;
        case "status":
            console.log("TODO: 显示状态");
            break;
        case "help":
        default:
            showHelp();
    }
}
async function startServer(args) {
    console.log(chalk_1.default.cyan("\n=== CC 小程序本地后端 ===\n"));
    // 检测版本更新（静默，不阻塞）
    await checkVersionUpdate();
    // 杀掉旧进程，确保端口可用
    killExistingProcess(Number(PORT));
    // 并行检查 CC CLI 和 cloudflared 以加快启动速度
    console.log("检查 Claude Code CLI...");
    console.log("检查 cloudflared...");
    const [ccAvailable, cloudflaredAvailable] = await Promise.all([
        (0, cc_bridge_js_1.checkCCAvailable)(),
        checkCloudflared()
    ]);
    // 处理 CC CLI 检查结果
    if (!ccAvailable) {
        console.error(chalk_1.default.red("错误: Claude Code CLI 未安装或不可用"));
        console.error("请先安装: npm install -g @anthropic-ai/claude-code");
        process.exit(1);
    }
    console.log(chalk_1.default.green("✓ Claude Code CLI 可用\n"));
    // 处理 cloudflared 检查结果
    if (!cloudflaredAvailable) {
        console.error(chalk_1.default.red("错误: cloudflared 未安装"));
        if (isWindows()) {
            console.error("安装方法: 从 https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/ 下载");
            console.error("       下载后解压，将 cloudflared.exe 添加到 PATH 环境变量");
        }
        else {
            console.error("安装方法: brew install cloudflare/cloudflare/cloudflared");
        }
        process.exit(1);
    }
    console.log(chalk_1.default.green("✓ cloudflared 可用\n"));
    // 解析工作目录
    const cwdIndex = args.indexOf("--cwd");
    let cwd;
    if (cwdIndex !== -1 && args[cwdIndex + 1]) {
        // 用户显式指定了 --cwd
        cwd = args[cwdIndex + 1];
    }
    else {
        // 自动检测：从当前目录向上查找项目根目录
        const detected = findProjectRoot(process.cwd());
        if (detected) {
            cwd = detected;
            if (detected !== process.cwd()) {
                console.log(chalk_1.default.cyan(`自动检测到项目根目录: ${detected}`));
            }
        }
        else {
            // 没找到，使用当前目录，但给出警告
            cwd = process.cwd();
            console.log(chalk_1.default.yellow("⚠️  未检测到 .claude/ 或 CLAUDE.md，使用当前目录"));
            console.log(chalk_1.default.yellow("   如果 hooks 不生效，请用 --cwd 指定项目根目录\n"));
        }
    }
    console.log(`工作目录: ${cwd}\n`);
    // 生成配对码
    const pairCode = generateCode();
    // 启动 HTTP 服务器（先不传 token）
    const server = new http_server_js_1.HttpServer(pairCode, cwd);
    await server.start();
    // 启动 cloudflared tunnel
    console.log(chalk_1.default.yellow("启动 tunnel...\n"));
    const tunnelUrl = await startTunnel(Number(PORT));
    if (!tunnelUrl) {
        console.error(chalk_1.default.red("错误: 无法获取 tunnel URL"));
        process.exit(1);
    }
    console.log(chalk_1.default.green(`✓ Tunnel 已启动: ${tunnelUrl}\n`));
    // 向 Worker 注册，获取 token
    console.log(chalk_1.default.yellow("向中转服务器注册...\n"));
    let token = await registerToWorker(tunnelUrl, pairCode);
    let mpUrl;
    if (!token) {
        console.error(chalk_1.default.red("警告: 无法注册到中转服务器，小程序可能无法使用"));
        console.log(chalk_1.default.gray("（直接访问 tunnel URL 仍可用于测试）\n"));
        mpUrl = tunnelUrl; // fallback
        token = null;
    }
    else {
        console.log(chalk_1.default.green("✓ 注册成功\n"));
        mpUrl = `${WORKER_URL}/${token}`;
        // 更新 HTTP 服务器的 token
        server.setToken(token);
    }
    // 保存连接信息到文件（方便 AI 读取）
    // 优先级：MYCC_SKILL_DIR 环境变量 > cwd/.claude/skills/mycc > ~/.mycc/
    const saveConnectionInfo = () => {
        let myccDir;
        const envSkillDir = process.env.MYCC_SKILL_DIR;
        const cwdSkillDir = (0, path_1.join)(cwd, ".claude", "skills", "mycc");
        const homeDir = (0, path_1.join)((0, os_1.homedir)(), ".mycc");
        if (envSkillDir && (0, fs_1.existsSync)(envSkillDir)) {
            // 环境变量指定且存在
            myccDir = envSkillDir;
        }
        else if ((0, fs_1.existsSync)((0, path_1.join)(cwd, ".claude", "skills", "mycc"))) {
            // cwd 下有 skill 目录
            myccDir = cwdSkillDir;
        }
        else {
            // fallback 到 ~/.mycc/
            myccDir = homeDir;
        }
        const infoPath = (0, path_1.join)(myccDir, "current.json");
        try {
            (0, fs_1.mkdirSync)(myccDir, { recursive: true });
            (0, fs_1.writeFileSync)(infoPath, JSON.stringify({
                routeToken: token,
                pairCode,
                tunnelUrl,
                mpUrl,
                cwd,
                startedAt: new Date().toISOString(),
            }, null, 2));
            console.log(chalk_1.default.gray(`连接信息已保存到: ${infoPath}`));
        }
        catch (err) {
            console.error(chalk_1.default.yellow("警告: 无法保存连接信息到文件"), err);
        }
    };
    // 保存到文件
    saveConnectionInfo();
    // 打印连接信息的函数
    const printConnectionInfo = () => {
        console.log(chalk_1.default.yellow("\n========== 连接信息 ==========\n"));
        qrcode_terminal_1.default.generate(mpUrl, { small: true });
        console.log(`\n小程序 URL: ${chalk_1.default.cyan(mpUrl)}`);
        if (token) {
            console.log(`连接码: ${chalk_1.default.cyan(token)}`);
        }
        console.log(`配对码: ${chalk_1.default.cyan(pairCode)}`);
        console.log(chalk_1.default.gray(`\nTunnel: ${tunnelUrl}`));
        console.log(chalk_1.default.yellow("\n==============================\n"));
    };
    // 显示配对信息
    printConnectionInfo();
    console.log(chalk_1.default.green("✓ 服务已就绪，等待配对...\n"));
    console.log(chalk_1.default.gray("按回车键重新显示连接信息"));
    console.log(chalk_1.default.gray("按 Ctrl+C 退出\n"));
    // 监听键盘输入，按回车重新打印连接信息
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", (key) => {
            // Ctrl+C
            if (key[0] === 3) {
                console.log(chalk_1.default.yellow("\n正在退出..."));
                server.stop();
                process.exit(0);
            }
            // Enter
            if (key[0] === 13) {
                printConnectionInfo();
            }
        });
    }
    // 处理退出
    process.on("SIGINT", () => {
        console.log(chalk_1.default.yellow("\n正在退出..."));
        server.stop();
        process.exit(0);
    });
    process.on("SIGTERM", () => {
        server.stop();
        process.exit(0);
    });
}
// cloudflared 路径（优先使用环境变量，否则尝试常见路径）
// 使用相对于当前工作目录的路径，因为脚本是从项目根目录执行的
function getCloudflaredPath() {
    // 首先检查环境变量
    if (process.env.CLOUDFLARED_PATH) {
        return process.env.CLOUDFLARED_PATH;
    }
    // 尝试从项目根目录查找 cloudflared.exe
    // 先找到项目根目录
    const projectRoot = findProjectRoot(process.cwd()) || process.cwd();
    const cloudflaredInProject = (0, path_1.join)(projectRoot, ".claude", "skills", "mycc", "scripts", "cloudflared.exe");
    console.log(`[DEBUG] projectRoot: "${projectRoot}"`);
    console.log(`[DEBUG] cloudflaredInProject: "${cloudflaredInProject}"`);
    if (fs_2.default.existsSync(cloudflaredInProject)) {
        console.log(`[DEBUG] Found cloudflared in project: "${cloudflaredInProject}"`);
        return cloudflaredInProject;
    }
    // 平台特定的默认路径
    if (process.platform === "win32") {
        return "cloudflared.exe"; // Windows - PATH 中的
    }
    else if (process.platform === "darwin") {
        return "/opt/homebrew/bin/cloudflared"; // macOS ARM
    }
    else {
        return "/usr/local/bin/cloudflared"; // macOS Intel / Linux
    }
}
const CLOUDFLARED_PATH = getCloudflaredPath();
async function checkCloudflared() {
    return new Promise((resolve) => {
        console.log(chalk_1.default.gray(`检查 cloudflared 路径: ${CLOUDFLARED_PATH}`));
        const proc = (0, child_process_1.spawn)(CLOUDFLARED_PATH, ["--version"]);
        proc.on("close", (code) => {
            console.log(chalk_1.default.gray(`cloudflared 退出码: ${code}`));
            resolve(code === 0);
        });
        proc.on("error", (error) => {
            console.log(chalk_1.default.gray(`cloudflared 错误: ${error.message}`));
            resolve(false);
        });
    });
}
// 向 Worker 注册 tunnel URL，返回 token
// 使用 Node.js 内置 https 模块，避免依赖外部 curl 命令
// 带重试机制，最多尝试 3 次
async function registerToWorker(tunnelUrl, pairCode) {
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 2000; // 2秒
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(chalk_1.default.gray(`注册尝试 ${attempt}/${MAX_RETRIES}...`));
            // 尝试使用 Node.js https 模块
            const token = await makeHttpRequest(tunnelUrl, pairCode, attempt);
            if (token) {
                console.log(chalk_1.default.green(`✓ 注册成功 (第 ${attempt} 次尝试)`));
                return token;
            }
        }
        catch (error) {
            const errMsg = error instanceof Error ? error.message : String(error);
            console.error(chalk_1.default.yellow(`注册尝试 ${attempt} 失败: ${errMsg}`));
            if (attempt < MAX_RETRIES) {
                console.log(chalk_1.default.gray(`等待 ${RETRY_DELAY / 1000} 秒后重试...`));
                await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
            }
        }
    }
    // 所有重试都失败，尝试 curl 作为最后的手段
    console.error(chalk_1.default.yellow("\n⚠️  HTTPS 请求全部失败，尝试使用 curl..."));
    try {
        const token = await makeCurlRequest(tunnelUrl, pairCode);
        if (token) {
            console.log(chalk_1.default.green(`✓ 使用 curl 注册成功`));
            return token;
        }
    }
    catch (curlError) {
        console.error(chalk_1.default.yellow(`curl 也失败: ${curlError}`));
    }
    // 所有方法都失败
    console.error(chalk_1.default.red("\n========================================"));
    console.error(chalk_1.default.red("错误: Worker 注册失败（已重试所有方法）"));
    console.error(chalk_1.default.red("========================================"));
    console.error(chalk_1.default.yellow("\n可能的原因:"));
    console.error("  1. 网络连接问题");
    console.error("  2. 代理服务器不稳定");
    console.error("  3. Worker 服务暂时不可用");
    console.error("  4. 服务器返回错误响应");
    console.error(chalk_1.default.yellow("\n解决方法:"));
    console.error("  1. 检查网络连接");
    console.error("  2. 稍后重启后端重试");
    console.error("  3. 可以直接使用 tunnel URL 测试（不经过 Worker）\n");
    return null;
}
// 使用 Node.js https 模块发送请求
async function makeHttpRequest(tunnelUrl, pairCode, attempt) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify({ tunnelUrl, pairCode });
        const url = new URL(`${WORKER_URL}/register`);
        const options = {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
                'User-Agent': 'mycc-backend/0.1.0'
            },
            timeout: 10000 // 10秒超时
        };
        const req = https_1.default.request(options, (res) => {
            let responseData = '';
            res.on('data', (chunk) => {
                responseData += chunk;
            });
            res.on('end', () => {
                console.log(chalk_1.default.gray(`HTTP ${res.statusCode} ${res.statusMessage}`));
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode}: ${responseData.substring(0, 100)}`));
                    return;
                }
                if (!responseData || responseData.trim() === '') {
                    reject(new Error('空响应'));
                    return;
                }
                try {
                    const parsed = JSON.parse(responseData);
                    if (parsed.token) {
                        resolve(parsed.token);
                    }
                    else {
                        reject(new Error(parsed.error || '服务器返回错误'));
                    }
                }
                catch (error) {
                    reject(new Error(`JSON 解析失败: ${error instanceof Error ? error.message : String(error)}`));
                }
            });
        });
        req.on('error', (error) => {
            reject(new Error(`请求失败: ${error.message}`));
        });
        req.on('timeout', () => {
            req.destroy();
            reject(new Error('请求超时'));
        });
        req.write(data);
        req.end();
    });
}
// 使用 curl 作为备选方案
async function makeCurlRequest(tunnelUrl, pairCode) {
    return new Promise((resolve, reject) => {
        try {
            const data = JSON.stringify({ tunnelUrl, pairCode });
            // 转义双引号以便在命令行中使用
            const escapedData = data.replace(/"/g, '\\"');
            const curlCommand = `curl -s --max-time 10 -X POST "${WORKER_URL}/register" -H "Content-Type: application/json" -d "${escapedData}"`;
            console.log(chalk_1.default.gray(`执行 curl 命令: ${curlCommand.substring(0, 80)}...`));
            const result = (0, child_process_1.execSync)(curlCommand, { timeout: 15000 }).toString();
            if (!result || result.trim() === "") {
                reject(new Error("空响应"));
                return;
            }
            const parsed = JSON.parse(result);
            if (parsed.token) {
                resolve(parsed.token);
            }
            else {
                reject(new Error(parsed.error || "未知错误"));
            }
        }
        catch (error) {
            reject(new Error(`curl 命令失败: ${error instanceof Error ? error.message : String(error)}`));
        }
    });
}
async function startTunnel(port) {
    return new Promise((resolve) => {
        // --config /dev/null: 防止加载默认 config.yml（会影响 Quick Tunnel 路由）
        // Windows 上使用 nul，Unix 上使用 /dev/null
        const configArg = isWindows() ? "nul" : "/dev/null";
        const proc = (0, child_process_1.spawn)(CLOUDFLARED_PATH, ["tunnel", "--config", configArg, "--url", `http://localhost:${port}`], {
            stdio: ["ignore", "pipe", "pipe"],
        });
        let resolved = false;
        const urlPattern = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
        const handleOutput = (data) => {
            const output = data.toString();
            // cloudflared 输出 tunnel URL 到 stderr
            const match = output.match(urlPattern);
            if (match && !resolved) {
                resolved = true;
                resolve(match[0]);
            }
        };
        proc.stdout.on("data", handleOutput);
        proc.stderr.on("data", handleOutput);
        proc.on("error", (err) => {
            console.error("Tunnel error:", err);
            if (!resolved) {
                resolved = true;
                resolve(null);
            }
        });
        // 10 秒超时
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                resolve(null);
            }
        }, 10000);
    });
}
function showHelp() {
    console.log(`
${chalk_1.default.cyan("CC 小程序本地后端")}

${chalk_1.default.yellow("用法:")}
  cc-mp start [选项]    启动后端服务
  cc-mp status          查看状态
  cc-mp help            显示帮助

${chalk_1.default.yellow("选项:")}
  --cwd <目录>          指定工作目录 (默认: 当前目录)

${chalk_1.default.yellow("环境变量:")}
  PORT                  HTTP 服务端口 (默认: 8080)

${chalk_1.default.yellow("示例:")}
  cc-mp start
  cc-mp start --cwd /path/to/project
`);
}
main().catch((error) => {
    console.error(chalk_1.default.red("启动失败:"), error);
    process.exit(1);
});
//# sourceMappingURL=index.js.map