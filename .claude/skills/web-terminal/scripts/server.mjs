/**
 * CC Web Terminal Server
 *
 * 通过浏览器访问 Claude Code 终端
 * - node-pty 创建 PTY 运行 claude
 * - WebSocket 桥接浏览器 ↔ PTY
 * - xterm.js 前端渲染（CDN 加载）
 * - token 鉴权防止未授权访问
 */

import { createServer } from "http";
import { randomBytes } from "crypto";
import { writeFileSync, mkdirSync, existsSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { WebSocketServer } from "ws";
import pty from "node-pty";
import { platform } from "os";

const PORT = parseInt(process.env.WEB_TERMINAL_PORT || "7681");
const TOKEN = process.env.WEB_TERMINAL_TOKEN || randomBytes(16).toString("hex");
const SHELL = platform() === "win32" ? "cmd.exe" : "bash";
const CWD = process.env.WEB_TERMINAL_CWD || process.cwd();

// 手机输入日志文件
const MOBILE_INPUT_LOG = join(CWD, ".web-terminal-mobile-input.log");

// 要启动的命令
// 优先用 --resume <session-id> 精确接续指定会话
// 否则 fallback 到 --continue（接续最近对话）
const CMD = process.env.WEB_TERMINAL_CMD || "claude";
const CMD_ARGS = (() => {
  if (process.env.WEB_TERMINAL_CMD_ARGS) return process.env.WEB_TERMINAL_CMD_ARGS.split(" ");
  if (process.env.WEB_TERMINAL_SESSION_ID) return ["--resume", process.env.WEB_TERMINAL_SESSION_ID];
  return ["--continue"];
})();

const HTML_PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>CC Terminal</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #1a1b26; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }

    /* 顶部工具栏 */
    #header {
      display: flex; align-items: center; justify-content: space-between;
      height: 44px; padding: 0 12px;
      background: #16161e; border-bottom: 1px solid #2a2b3d;
    }
    #header .title {
      font-size: 16px; font-weight: 600; color: #e06c75;
      display: flex; align-items: center; gap: 8px;
    }
    #header .title span { color: #cdd6f4; font-size: 12px; font-weight: 400; }
    #header .tools { display: flex; align-items: center; gap: 4px; }
    #header .tools button {
      background: none; border: none; color: #6c7086; font-size: 14px;
      padding: 6px 8px; cursor: pointer; border-radius: 4px;
      font-family: monospace;
    }
    #header .tools button:active { background: #2a2b3d; }
    #status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #f38ba8; display: inline-block;
    }
    #status-dot.connected { background: #a6e3a1; }
    #status-label { color: #6c7086; font-size: 12px; margin-left: 4px; }
    #status-label.connected { color: #a6e3a1; }

    /* 终端区域 */
    #terminal {
      width: 100vw;
      height: calc(100vh - 44px - 48px - 52px);
      overflow: hidden;
    }

    /* 底部快捷键栏 */
    #shortcut-bar {
      display: flex; align-items: center; justify-content: center;
      gap: 8px; height: 48px; padding: 0 8px;
      background: #16161e; border-top: 1px solid #2a2b3d;
    }
    #shortcut-bar button {
      padding: 8px 16px; border-radius: 6px; border: 1px solid #2a2b3d;
      background: #1a1b26; color: #cdd6f4; font-size: 13px;
      font-family: monospace; cursor: pointer; min-width: 48px;
    }
    #shortcut-bar button:active { background: #2a2b3d; }
    #shortcut-bar button.stop-btn {
      background: #e06c75; color: #1a1b26; border-color: #e06c75; font-weight: 600;
    }
    #shortcut-bar button.stop-btn:active { background: #c75a63; }

    /* 底部输入栏 */
    #input-bar {
      display: flex; align-items: center; gap: 8px;
      height: 52px; padding: 6px 12px;
      background: #16161e; border-top: 1px solid #2a2b3d;
    }
    #input-bar .attach-btn {
      background: none; border: none; color: #6c7086; font-size: 20px;
      cursor: pointer; padding: 4px;
    }
    #input-bar input {
      flex: 1; height: 36px; padding: 0 12px;
      background: #1a1b26; border: 1px solid #2a2b3d; border-radius: 18px;
      color: #cdd6f4; font-size: 14px; outline: none;
      font-family: "Cascadia Code", "Fira Code", monospace;
    }
    #input-bar input::placeholder { color: #6c7086; }
    #input-bar input:focus { border-color: #585b70; }
    #input-bar .send-btn {
      width: 36px; height: 36px; border-radius: 50%;
      background: #e06c75; border: none; color: #1a1b26;
      font-size: 18px; cursor: pointer; display: flex;
      align-items: center; justify-content: center;
    }
    #input-bar .send-btn:active { background: #c75a63; }

    /* 搜索框 */
    #search-bar {
      display: none; position: absolute; top: 44px; right: 8px; z-index: 20;
      background: #16161e; border: 1px solid #2a2b3d; border-radius: 8px;
      padding: 8px; box-shadow: 0 4px 12px rgba(0,0,0,0.5);
    }
    #search-bar.show { display: flex; align-items: center; gap: 6px; }
    #search-bar input {
      width: 200px; height: 30px; padding: 0 8px;
      background: #1a1b26; border: 1px solid #2a2b3d; border-radius: 4px;
      color: #cdd6f4; font-size: 13px; outline: none;
    }
    #search-bar button {
      background: none; border: none; color: #6c7086; cursor: pointer;
      font-size: 14px; padding: 4px;
    }
  </style>
</head>
<body>
  <!-- 顶部栏 -->
  <div id="header">
    <div class="title">Claude Code <span id="version-info"></span></div>
    <div class="tools">
      <button id="btn-font-down" title="缩小字号">A-</button>
      <button id="btn-font-up" title="放大字号">A+</button>
      <button id="btn-search" title="搜索">&#x1F50D;</button>
      <span id="status-dot"></span>
      <span id="status-label">connecting</span>
    </div>
  </div>

  <!-- 搜索框 -->
  <div id="search-bar">
    <input type="text" id="search-input" placeholder="搜索...">
    <button id="search-prev">&uarr;</button>
    <button id="search-next">&darr;</button>
    <button id="search-close">&times;</button>
  </div>

  <!-- 终端 -->
  <div id="terminal"></div>

  <!-- 快捷键栏 -->
  <div id="shortcut-bar">
    <button class="stop-btn" id="btn-stop">Stop</button>
    <button id="btn-enter">Enter</button>
    <button id="btn-tab">Tab</button>
    <button id="btn-esc">Esc</button>
    <button id="btn-up">&uarr;</button>
    <button id="btn-down">&darr;</button>
  </div>

  <!-- 输入栏 -->
  <div id="input-bar">
    <button class="attach-btn" id="btn-attach" title="附件">&#128206;</button>
    <input type="file" id="file-input" style="display:none" multiple>
    <input type="text" id="cmd-input" placeholder="输入命令..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
    <button class="send-btn" id="btn-send">&#10148;</button>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-search@0.15.0/lib/addon-search.min.js"></script>
  <script>
    const token = new URLSearchParams(location.search).get("token");
    if (!token) { document.getElementById("status-label").textContent = "no token"; throw new Error("No token"); }

    let fontSize = 14;
    const term = new Terminal({
      cursorBlink: true, fontSize: fontSize,
      fontFamily: '"Cascadia Code", "Fira Code", monospace',
      theme: { background: "#1a1b26", foreground: "#cdd6f4", cursor: "#f5e0dc", selectionBackground: "#585b70",
        black: "#1a1b26", red: "#e06c75", green: "#a6e3a1", yellow: "#e0af68",
        blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#cdd6f4" },
    });

    const fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    const searchAddon = new SearchAddon.SearchAddon();
    term.loadAddon(fitAddon); term.loadAddon(webLinksAddon); term.loadAddon(searchAddon);
    term.open(document.getElementById("terminal"));
    fitAddon.fit();

    // WebSocket with auto-reconnect
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = proto + "//" + location.host + "/ws?token=" + token;
    const dot = document.getElementById("status-dot");
    const label = document.getElementById("status-label");
    let ws = null;
    let reconnectCount = 0;
    const MAX_RECONNECT = 10;

    function connectWs() {
      ws = new WebSocket(wsUrl);
      ws.onopen = () => {
        reconnectCount = 0;
        dot.className = "connected"; label.textContent = "Connected"; label.className = "connected";
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      };
      ws.onmessage = (e) => term.write(e.data);
      ws.onclose = () => {
        dot.className = ""; label.className = "";
        if (reconnectCount >= MAX_RECONNECT) { label.textContent = "Failed"; return; }
        reconnectCount++;
        label.textContent = "Reconnecting(" + reconnectCount + ")...";
        setTimeout(connectWs, 2000);
      };
      ws.onerror = () => { dot.className = ""; };
    }
    connectWs();

    term.onData((data) => { if (ws && ws.readyState === 1) ws.send(data); });
    term.onResize(({ cols, rows }) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "resize", cols, rows })); });

    function send(data) { if (ws && ws.readyState === 1) ws.send(data); }

    // 字号调节
    document.getElementById("btn-font-down").onclick = () => {
      fontSize = Math.max(10, fontSize - 2); term.options.fontSize = fontSize; fitAddon.fit();
    };
    document.getElementById("btn-font-up").onclick = () => {
      fontSize = Math.min(24, fontSize + 2); term.options.fontSize = fontSize; fitAddon.fit();
    };

    // 搜索
    const searchBar = document.getElementById("search-bar");
    const searchInput = document.getElementById("search-input");
    document.getElementById("btn-search").onclick = () => {
      searchBar.classList.toggle("show"); if (searchBar.classList.contains("show")) searchInput.focus();
    };
    document.getElementById("search-close").onclick = () => { searchBar.classList.remove("show"); searchAddon.clearDecorations(); };
    searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") searchAddon.findNext(searchInput.value); });
    document.getElementById("search-prev").onclick = () => searchAddon.findPrevious(searchInput.value);
    document.getElementById("search-next").onclick = () => searchAddon.findNext(searchInput.value);

    // 快捷键
    document.getElementById("btn-stop").onclick = () => send("\\x03"); // Ctrl+C
    document.getElementById("btn-enter").onclick = () => send("\\r");
    document.getElementById("btn-tab").onclick = () => send("\\t");
    document.getElementById("btn-esc").onclick = () => send("\\x1b");
    document.getElementById("btn-up").onclick = () => send("\\x1b[A");
    document.getElementById("btn-down").onclick = () => send("\\x1b[B");

    // 输入栏
    const cmdInput = document.getElementById("cmd-input");
    document.getElementById("btn-send").onclick = () => {
      if (cmdInput.value) { send(cmdInput.value + "\\r"); cmdInput.value = ""; }
    };
    cmdInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); send(cmdInput.value + "\\r"); cmdInput.value = ""; }
    });

    // 附件上传
    document.getElementById("btn-attach").onclick = () => document.getElementById("file-input").click();
    document.getElementById("file-input").addEventListener("change", async (e) => {
      const files = e.target.files;
      if (!files.length) return;
      for (const file of files) {
        const formData = new FormData();
        formData.append("file", file);
        try {
          const resp = await fetch("/upload?token=" + token, { method: "POST", body: formData });
          if (resp.ok) {
            const data = await resp.json();
            // 把文件路径发送到终端
            send(data.path + "\\r");
          } else {
            term.write("\\r\\n\\x1b[31m[上传失败: " + resp.statusText + "]\\x1b[0m\\r\\n");
          }
        } catch (err) {
          term.write("\\r\\n\\x1b[31m[上传错误: " + err.message + "]\\x1b[0m\\r\\n");
        }
      }
      e.target.value = "";
    });

    // 自适应
    window.addEventListener("resize", () => fitAddon.fit());
    document.addEventListener("dblclick", (e) => e.preventDefault());

    // 移动端虚拟键盘弹出时重新 fit
    if ("visualViewport" in window) {
      window.visualViewport.addEventListener("resize", () => {
        setTimeout(() => fitAddon.fit(), 100);
      });
    }
  </script>
</body>
</html>`;

// --- HTTP Server ---
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", pid: process.pid }));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    // 验证 token
    const t = url.searchParams.get("token");
    if (t !== TOKEN) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden: invalid token");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(HTML_PAGE);
    return;
  }

  // 文件上传
  if (url.pathname === "/upload" && req.method === "POST") {
    const t = url.searchParams.get("token");
    if (t !== TOKEN) {
      res.writeHead(403); res.end("Forbidden"); return;
    }

    const uploadDir = join(CWD, ".web-terminal-uploads");
    if (!existsSync(uploadDir)) mkdirSync(uploadDir, { recursive: true });

    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      // 解析 multipart boundary
      const contentType = req.headers["content-type"] || "";
      const boundaryMatch = contentType.match(/boundary=(.+)/);
      if (!boundaryMatch) {
        res.writeHead(400); res.end("No boundary"); return;
      }
      const boundary = "--" + boundaryMatch[1];
      const parts = body.toString("binary").split(boundary).filter(p => p.includes("filename="));

      if (!parts.length) {
        res.writeHead(400); res.end("No file"); return;
      }

      const part = parts[0];
      const filenameMatch = part.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : "upload_" + Date.now();
      // 安全：只取文件名，防止路径穿越
      const safeName = filename.replace(/[/\\\\:*?"<>|]/g, "_");

      // 提取文件内容（在两个 \\r\\n\\r\\n 之后，最后的 \\r\\n-- 之前）
      const headerEnd = part.indexOf("\\r\\n\\r\\n");
      if (headerEnd === -1) { res.writeHead(400); res.end("Bad format"); return; }
      const fileContent = part.slice(headerEnd + 4, part.lastIndexOf("\\r\\n"));

      const filePath = join(uploadDir, safeName);
      writeFileSync(filePath, fileContent, "binary");

      console.log("[web-terminal] 文件上传: " + filePath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: filePath, name: safeName }));
    });
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

// --- 持久 PTY 会话（所有客户端共享） ---
const isWin = platform() === "win32";
const spawnCmd = isWin ? "cmd.exe" : CMD;
const spawnArgs = isWin ? ["/c", CMD, ...CMD_ARGS] : CMD_ARGS;

let sharedPty = null;
let scrollbackBuffer = ""; // 保留最近输出，新连接时回放
const MAX_SCROLLBACK = 50000; // 最多保留 50KB

function ensurePty() {
  if (sharedPty) return sharedPty;

  console.log("[web-terminal] 创建持久会话: " + spawnCmd + " " + spawnArgs.join(" "));
  sharedPty = pty.spawn(spawnCmd, spawnArgs, {
    name: "xterm-256color",
    cols: 120,
    rows: 30,
    cwd: CWD,
    env: {
      ...filterEnv(process.env),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
    },
  });

  sharedPty.onData((data) => {
    // 追加到滚动缓冲区
    scrollbackBuffer += data;
    if (scrollbackBuffer.length > MAX_SCROLLBACK) {
      scrollbackBuffer = scrollbackBuffer.slice(-MAX_SCROLLBACK);
    }
    // 广播给所有连接的客户端
    wss.clients.forEach((client) => {
      try { client.send(data); } catch {}
    });
  });

  sharedPty.onExit(({ exitCode }) => {
    console.log("[web-terminal] 会话退出, code=" + exitCode);
    const msg = "\r\n\x1b[33m[会话已退出, code=" + exitCode + "]\x1b[0m\r\n";
    scrollbackBuffer += msg;
    wss.clients.forEach((client) => {
      try { client.send(msg); client.close(); } catch {}
    });
    sharedPty = null;
    scrollbackBuffer = "";
  });

  return sharedPty;
}

// 延迟创建：等第一个客户端连接时再启动 claude
// 这样用户可以先退出 PC 上的 CC，再从手机连入接续对话

// --- WebSocket Server ---
const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost:" + PORT);
  const t = url.searchParams.get("token");

  if (t !== TOKEN) {
    ws.close(4003, "Forbidden");
    return;
  }

  console.log("[web-terminal] 新连接 (当前客户端: " + (wss.clients.size) + ")");

  // 确保 PTY 存在（如果之前退出了则重建）
  const ptyProc = ensurePty();

  // 回放历史输出，让新连接看到之前的内容
  if (scrollbackBuffer) {
    try { ws.send(scrollbackBuffer); } catch {}
  }

  ws.on("message", (msg) => {
    const str = msg.toString();
    try {
      const parsed = JSON.parse(str);
      if (parsed.type === "resize" && parsed.cols && parsed.rows) {
        // 只有最后一个连接的 resize 生效
        ptyProc.resize(parsed.cols, parsed.rows);
        return;
      }
    } catch {}

    // 记录手机输入到日志文件
    const timestamp = new Date().toISOString().slice(11, 19);
    const logLine = `[${timestamp}] [手机端] ${str.replace(/\r?\n/g, "\\n")}\n`;
    try { appendFileSync(MOBILE_INPUT_LOG, logLine); } catch {}

    ptyProc.write(str);
  });

  ws.on("close", () => {
    console.log("[web-terminal] 连接关闭 (剩余客户端: " + (wss.clients.size - 1) + ")");
    // 不 kill PTY！会话保持运行
  });
});

// 环境变量白名单，不透传敏感信息
function filterEnv(env) {
  const allow = [
    "PATH", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
    "SHELL", "LANG", "LC_ALL", "TERM",
    "ANTHROPIC_API_KEY", "CLAUDE_CODE_USE_BEDROCK",
    "SystemRoot", "SYSTEMROOT", "windir",
    "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "PROGRAMFILES", "PROGRAMFILES(X86)", "COMMONPROGRAMFILES",
    "NODE_PATH", "NVM_HOME", "FNM_DIR",
  ];
  const filtered = {};
  for (const key of allow) {
    if (env[key]) filtered[key] = env[key];
  }
  return filtered;
}

// --- 启动 ---
server.listen(PORT, "127.0.0.1", () => {
  console.log("");
  console.log("  ╔══════════════════════════════════════╗");
  console.log("  ║     CC Web Terminal 已启动           ║");
  console.log("  ╠══════════════════════════════════════╣");
  console.log("  ║  本地: http://127.0.0.1:" + PORT + "/?token=" + TOKEN);
  console.log("  ║                                      ║");
  console.log("  ║  Token: " + TOKEN);
  console.log("  ╚══════════════════════════════════════╝");
  console.log("");
  console.log("  提示: 用 cloudflared 或 localtunnel 穿透后可手机访问");
  console.log("  例: npx localtunnel --port " + PORT);
  console.log("  或: cloudflared tunnel --url http://127.0.0.1:" + PORT);
  console.log("");
});

// 优雅退出
process.on("SIGINT", () => {
  console.log("\\n[web-terminal] 正在关闭...");
  wss.clients.forEach((ws) => ws.close());
  server.close();
  process.exit(0);
});
