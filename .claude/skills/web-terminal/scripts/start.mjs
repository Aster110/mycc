/**
 * Web Terminal 一键启动脚本
 *
 * 自动完成:
 * 1. 清理旧进程 → 启动本地服务
 * 2. 健康检查确认服务就绪
 * 3. 启动 cloudflared 穿透
 * 4. 保存连接信息到 current.json
 * 5. 推送访问链接到飞书（如果 tell-me 可用）
 */

import { spawn, execSync } from "child_process";
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import http from "http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = join(__dirname, "..");
const PORT = parseInt(process.env.WEB_TERMINAL_PORT || "7681");
const TOKEN = process.env.WEB_TERMINAL_TOKEN || "mycc2026";

// 从 ~/.claude/sessions/ 读取最近活跃的 session ID
function findCurrentSessionId() {
  try {
    const sessDir = join(homedir(), ".claude", "sessions");
    const files = readdirSync(sessDir)
      .filter(f => f.endsWith(".json"))
      .map(f => ({ name: f, mtime: statSync(join(sessDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (!files.length) return null;
    const data = JSON.parse(readFileSync(join(sessDir, files[0].name), "utf-8"));
    if (data.sessionId) {
      console.log("[start] 找到当前会话: " + data.sessionId.slice(0, 8) + "...");
      return data.sessionId;
    }
  } catch {}
  return null;
}

// 健康检查，最多重试 10 次
function waitForHealth(maxRetries = 10) {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    function check() {
      attempt++;
      const req = http.get(`http://127.0.0.1:${PORT}/health`, (res) => {
        if (res.statusCode === 200) return resolve(true);
        if (attempt < maxRetries) return setTimeout(check, 500);
        reject(new Error("Health check failed after " + maxRetries + " attempts"));
      });
      req.on("error", () => {
        if (attempt < maxRetries) return setTimeout(check, 500);
        reject(new Error("Server not responding after " + maxRetries + " attempts"));
      });
      req.setTimeout(2000, () => { req.destroy(); });
    }
    check();
  });
}

// 杀掉占用端口的进程 + 残留 cloudflared
function killPort() {
  try {
    const output = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: "utf-8" });
    const match = output.match(/LISTENING\s+(\d+)/);
    if (match) {
      execSync(`taskkill /F /PID ${match[1]}`, { stdio: "ignore" });
      console.log("[start] 已清理旧进程 PID=" + match[1]);
    }
  } catch {}
  // 清理 web-terminal 自己之前的 cloudflared（按 current.json 中记录的 PID）
  // 不要 taskkill /IM cloudflared.exe，会误杀 mycc 的 tunnel
  try {
    const curFile = join(SKILL_DIR, "current.json");
    if (existsSync(curFile)) {
      const cur = JSON.parse(readFileSync(curFile, "utf-8"));
      if (cur.cfPid) {
        execSync(`taskkill /F /PID ${cur.cfPid}`, { stdio: "ignore" });
        console.log("[start] 已清理旧 cloudflared PID=" + cur.cfPid);
      }
    }
  } catch {}
}

// 启动 cloudflared，从 stderr 提取 URL（支持重试 + http2 降级）
function startTunnelOnce(protocol) {
  const isWin = process.platform === "win32";
  const args = ["tunnel", "--url", `http://127.0.0.1:${PORT}`];
  if (protocol) args.push("--protocol", protocol);

  // Windows: 用 cmd /c start 启动独立进程，避免 Node 退出后 cloudflared 跟着死
  // 但我们仍需读 stderr 来拿 URL，所以先用 pipe 模式启动，拿到 URL 后再分离
  const proc = spawn("cloudflared", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: isWin, // Windows 上 detached 创建新进程组
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("cloudflared 启动超时(20s)"));
    }, 20000);
    let resolved = false;

    function tryMatch(data) {
      if (resolved) return;
      const str = data.toString();
      const match = str.match(/(https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com)/);
      if (match) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ proc, url: match[1] });
      }
    }

    proc.stderr.on("data", tryMatch);
    proc.stdout.on("data", tryMatch);

    proc.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error("cloudflared 启动失败: " + err.message));
    });
    proc.on("exit", (code) => {
      if (!resolved) {
        clearTimeout(timeout);
        reject(new Error("cloudflared 退出, code=" + code));
      }
    });
  });
}

async function startTunnel() {
  console.log("[start] 启动 cloudflared 隧道...");

  // 策略：http2 优先（quic 经常被阻断），递增等待避开速率限制
  const attempts = ["http2", "http2", "http2"];
  const delays = [0, 30000, 60000]; // 首次立即，第二次等30秒，第三次等60秒
  for (let i = 0; i < attempts.length; i++) {
    const protocol = attempts[i];
    try {
      if (delays[i] > 0) {
        console.log("[start] 等待 " + (delays[i] / 1000) + " 秒后重试（避开速率限制）...");
        await new Promise(r => setTimeout(r, delays[i]));
      }
      if (i > 0) console.log("[start] 重试隧道 (" + (i + 1) + "/" + attempts.length + ")...");
      const result = await startTunnelOnce(protocol);
      return result;
    } catch (err) {
      console.log("[start] 尝试 " + (i + 1) + "/" + attempts.length + " 失败: " + err.message);
      if (i === attempts.length - 1) throw err;
    }
  }
}

// 保存连接信息
function saveCurrentInfo(tunnelUrl, sessionId, cfPid) {
  const info = {
    tunnelUrl,
    accessUrl: `${tunnelUrl}/?token=${TOKEN}`,
    token: TOKEN,
    port: PORT,
    sessionId: sessionId || null,
    resumeCmd: sessionId ? `claude --resume ${sessionId}` : "claude --continue",
    startedAt: new Date().toISOString(),
    pid: process.pid,
    cfPid: cfPid || null,
  };
  const filePath = join(SKILL_DIR, "current.json");
  writeFileSync(filePath, JSON.stringify(info, null, 2));
  console.log("[start] 连接信息已保存: " + filePath);
  return info;
}

// 推送到飞书（通过 tell-me/send.js）
function pushToFeishu(accessUrl) {
  try {
    const sendScript = join(__dirname, "../../tell-me/send.js");
    if (!existsSync(sendScript)) return;
    const proc = spawn("node", [sendScript, "Web Terminal", accessUrl, "green"], {
      stdio: "ignore", detached: true,
    });
    proc.unref();
    console.log("[start] 已推送链接到飞书");
  } catch {
    // 飞书推送是可选的，失败不影响
  }
}

async function main() {
  console.log("\n== Web Terminal 启动 ==\n");

  // 1. 清理旧进程
  killPort();

  // 2. 读取当前会话 ID + 启动服务
  const sessionId = findCurrentSessionId();
  const projectRoot = join(__dirname, "..", "..", "..", "..");
  const serverEnv = { ...process.env, WEB_TERMINAL_TOKEN: TOKEN, WEB_TERMINAL_CWD: projectRoot };
  // 不设置 WEB_TERMINAL_SESSION_ID，让 server 默认用 --continue

  console.log("[start] 启动本地服务（后台常驻）...");
  const serverProc = spawn("node", ["server.mjs"], {
    cwd: __dirname,
    env: serverEnv,
    stdio: "ignore",
    detached: true,
  });
  serverProc.unref(); // 脱离父进程，终端关了服务不死

  serverProc.on("error", (err) => {
    console.error("[start] 服务启动失败: " + err.message);
    process.exit(1);
  });

  // 3. 健康检查
  try {
    await waitForHealth();
    console.log("[start] 服务就绪");
  } catch (err) {
    console.error("[start] " + err.message);
    process.exit(1);
  }

  // 4. 启动隧道
  try {
    const { proc: cfProc, url } = await startTunnel();
    // 断开 pipe 并 unref，让 start.mjs 能退出，cloudflared 继续运行
    cfProc.stdout?.removeAllListeners();
    cfProc.stderr?.removeAllListeners();
    cfProc.removeAllListeners();
    // Windows: 必须先 destroy pipe 再 unref，否则断管会杀进程
    if (cfProc.stdout) { cfProc.stdout.destroy(); }
    if (cfProc.stderr) { cfProc.stderr.destroy(); }
    if (cfProc.stdin) { cfProc.stdin.destroy(); }
    cfProc.unref();
    const info = saveCurrentInfo(url, sessionId, cfProc.pid);

    console.log("\n== 启动成功 ==");
    console.log("  访问: " + info.accessUrl);
    console.log("  Token: " + TOKEN);
    console.log("");

    // 5. 推送飞书（异步，不阻塞）
    pushToFeishu(info.accessUrl);
  } catch (err) {
    console.error("[start] 隧道启动失败: " + err.message);
    console.log("[start] 本地服务仍可用: http://127.0.0.1:" + PORT + "/?token=" + TOKEN);
  }
}

main().catch(console.error);
