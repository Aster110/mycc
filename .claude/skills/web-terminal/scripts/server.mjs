#!/usr/bin/env node
/**
 * web-terminal server — multi-tab AI terminal
 * Based on fncc-web-terminal, extended with multi-tab + token auth
 */

import http from 'http';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PORT = parseInt(process.env.WEB_TERMINAL_PORT || '7681');
const TOKEN = process.env.WEB_TERMINAL_TOKEN || crypto.randomBytes(12).toString('hex');
const CWD = process.env.WEB_TERMINAL_CWD || process.cwd();
const MAX_SCROLLBACK = 50 * 1024;
const MAX_UPLOAD_SIZE = 50 * 1024 * 1024; // 50MB

// Tab definitions
const TABS = [
  { id: 'claude', label: 'Claude Code', cmd: 'claude', args: ['--continue'] },
  { id: 'codex', label: 'Codex', cmd: 'codex', args: [] },
];

if (process.env.WEB_TERMINAL_TABS) {
  try {
    const custom = JSON.parse(process.env.WEB_TERMINAL_TABS);
    TABS.length = 0;
    TABS.push(...custom);
  } catch (e) {
    console.error('[web-terminal] Invalid WEB_TERMINAL_TABS JSON, using defaults');
  }
}

// Per-tab state
const tabState = {};
for (const tab of TABS) {
  tabState[tab.id] = { pty: null, scrollback: '', status: 'idle' };
}

function appendScrollback(tabId, data) {
  const state = tabState[tabId];
  if (!state) return;
  state.scrollback += data;
  if (state.scrollback.length > MAX_SCROLLBACK) {
    state.scrollback = state.scrollback.slice(state.scrollback.length - MAX_SCROLLBACK);
  }
}

function spawnTab(tabId, cols, rows) {
  const tab = TABS.find(t => t.id === tabId);
  const state = tabState[tabId];
  if (!tab || !state || state.pty) return;

  let spawnCmd, spawnArgs;
  if (process.platform === 'win32') {
    spawnCmd = 'pwsh.exe';
    const initCmd = `[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${tab.cmd} ${tab.args.join(' ')}`;
    spawnArgs = ['-NoLogo', '-NoExit', '-Command', initCmd];
  } else {
    spawnCmd = 'bash';
    spawnArgs = ['-c', `${tab.cmd} ${tab.args.join(' ')}`];
  }

  try {
    state.pty = pty.spawn(spawnCmd, spawnArgs, {
      name: 'xterm-256color',
      cols: Math.max(cols || 120, 10),
      rows: Math.max(rows || 40, 5),
      cwd: CWD,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });

    state.status = 'running';
    broadcast({ type: 'status', tab: tabId, status: 'running' });

    state.pty.onData((data) => {
      appendScrollback(tabId, data);
      broadcast({ type: 'output', tab: tabId, data });
    });

    state.pty.onExit(() => {
      console.log(`[PTY] ${tab.label} exited`);
      state.pty = null;
      state.status = 'stopped';
      broadcast({ type: 'exit', tab: tabId });
    });

    console.log(`[PTY] Spawned ${tab.label}: ${tab.cmd} ${tab.args.join(' ')}`);
  } catch (e) {
    console.error(`[PTY] Failed to spawn ${tab.label}:`, e.message);
    state.status = 'error';
    broadcast({ type: 'status', tab: tabId, status: 'error' });
  }
}

// WebSocket clients
const clients = new Set();

function broadcast(msg) {
  const json = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

// ===== Login page =====
const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>CC Terminal</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1a1a2e;color:#e0e0e0;font-family:-apple-system,'Segoe UI',sans-serif;height:100dvh;display:flex;align-items:center;justify-content:center}
.box{background:#16213e;border:1px solid rgba(233,69,96,0.2);border-radius:12px;padding:36px;width:320px}
h2{margin-bottom:24px;font-size:18px;color:#e94560;text-align:center;font-weight:700}
input{width:100%;background:#1a1a2e;border:1px solid rgba(255,255,255,0.1);color:#e0e0e0;padding:12px;border-radius:8px;font-size:14px;outline:none;margin-bottom:14px}
input:focus{border-color:rgba(233,69,96,0.5)}
button{width:100%;background:#e94560;border:none;color:#fff;padding:12px;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600}
button:hover{opacity:0.9}
.err{color:#ff6b81;font-size:12px;margin-top:8px;text-align:center;display:none}
</style></head><body>
<div class="box">
<h2>CC Terminal</h2>
<input id="token" type="password" placeholder="Token..." autofocus>
<button onclick="login()">Enter</button>
<div class="err" id="err">Token incorrect</div>
</div>
<script>
async function login(){var t=document.getElementById('token').value;var r=await fetch('/auth',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:t})});if(r.ok)location.href='/terminal';else document.getElementById('err').style.display='block'}
document.getElementById('token').addEventListener('keydown',function(e){if(e.key==='Enter')login()});
</script></body></html>`;

// ===== Terminal page =====
const TABS_JSON = JSON.stringify(TABS.map(t => ({ id: t.id, label: t.label })));

const TERMINAL_HTML = `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>CC Terminal</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
@font-face {
  font-family: 'Symbols Nerd Font Mono';
  src: url('https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@v3.3.0/patched-fonts/NerdFontsSymbolsOnly/SymbolsNerdFontMono-Regular.ttf') format('truetype');
  font-weight: normal;
  font-style: normal;
  font-display: swap;
}
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#1a1a2e;overflow:hidden;font-family:-apple-system,'SF Pro Text','Segoe UI',sans-serif}

#app{display:flex;flex-direction:column;height:100vh;height:100dvh}

/* Header with tabs */
#header{
  display:flex;align-items:center;
  padding:0;height:36px;min-height:36px;
  background:#0d1326;border-bottom:1px solid rgba(233,69,96,0.15);
  flex-shrink:0;user-select:none;overflow-x:auto;
  -webkit-overflow-scrolling:touch;
}
.tab{
  padding:0 16px;height:100%;display:flex;align-items:center;
  font-size:13px;color:#666;cursor:pointer;white-space:nowrap;
  border-bottom:2px solid transparent;transition:all 0.2s;flex-shrink:0;
}
.tab.active{color:#e94560;border-bottom-color:#e94560}
.tab:active{opacity:0.7}
.header-right{
  margin-left:auto;display:flex;align-items:center;gap:6px;
  padding:0 12px;flex-shrink:0;
}
.dot{width:7px;height:7px;border-radius:50%;background:#f87171;flex-shrink:0;transition:background 0.3s}
.dot.on{background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,0.5)}
.status-text{font-size:11px;color:#666;transition:color 0.3s}
.status-text.on{color:#4ade80}
.yolo-btn{
  font-size:11px;padding:2px 8px;border-radius:10px;cursor:pointer;
  border:1px solid rgba(251,191,36,0.3);background:rgba(251,191,36,0.08);color:#888;
  transition:all 0.2s;font-weight:700;letter-spacing:0.5px;
}
.yolo-btn:hover{border-color:rgba(251,191,36,0.5)}
.yolo-btn.on{background:rgba(251,191,36,0.2);color:#fbbf24;border-color:#fbbf24;text-shadow:0 0 8px rgba(251,191,36,0.4)}

/* Terminal area */
#terminal-wrap{flex:1;min-height:0;position:relative;overflow:hidden}
.term-panel{position:absolute;inset:0;display:none;overflow:hidden}
.term-panel.active{display:block}
.term-panel .xterm{height:100%!important}
.term-panel .xterm-screen{height:100%!important}
.xterm-viewport{overflow-y:auto!important}
.xterm-viewport::-webkit-scrollbar{width:6px}
.xterm-viewport::-webkit-scrollbar-thumb{background:rgba(233,69,96,0.3);border-radius:3px}
.xterm-cursor-layer{opacity:0!important}
.xterm .xterm-helper-textarea{
  caret-color:transparent!important;
  color:transparent!important;
  background:transparent!important;
}

/* Overlay */
#overlay{
  display:none;position:absolute;inset:0;z-index:10;
  background:rgba(13,19,38,0.85);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  align-items:center;justify-content:center;flex-direction:column;gap:16px;
}
#overlay.show{display:flex}
#overlay .msg{color:#888;font-size:14px}
#overlay button{
  padding:10px 36px;font-size:14px;border:none;border-radius:20px;
  background:#e94560;color:#fff;cursor:pointer;font-weight:600;
  transition:transform 0.15s,box-shadow 0.15s;
}
#overlay button:hover{transform:scale(1.05);box-shadow:0 4px 20px rgba(233,69,96,0.4)}
#overlay button:active{transform:scale(0.97)}

/* Mobile bar — hidden on desktop */
#mobile-bar{display:none;flex-shrink:0}

@media (max-width:768px),(pointer:coarse){
  html,body{overscroll-behavior:none}
  #app{padding-bottom:env(safe-area-inset-bottom,0)}
  #header{height:44px;min-height:44px;padding-top:env(safe-area-inset-top,0)}
  .tab{font-size:14px;padding:0 16px;min-width:44px;justify-content:center}

  #mobile-bar{
    display:flex;flex-direction:column;gap:8px;
    background:#111833;border-top:1px solid rgba(233,69,96,0.12);
    flex-shrink:0;
    padding:8px 12px;padding-bottom:calc(8px + env(safe-area-inset-bottom,0));
  }
  .mobile-row{
    display:flex;align-items:center;gap:8px;
    overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;
  }
  .mobile-row::-webkit-scrollbar{display:none}
  .mobile-row-secondary{justify-content:center;overflow:visible}
  .mobile-row-arrows{justify-content:center;overflow:visible}
  .arrow-pad{
    display:grid;
    grid-template-columns:repeat(3,minmax(38px,46px));
    grid-template-rows:repeat(2,auto);
    gap:8px;
    justify-content:center;
  }
  .arrow-pad #btn-up{grid-column:2;grid-row:1}
  .arrow-pad #btn-left{grid-column:1;grid-row:2}
  .arrow-pad #btn-down{grid-column:2;grid-row:2}
  .arrow-pad #btn-right{grid-column:3;grid-row:2}
  .qk{
    padding:4px 7px;background:rgba(255,255,255,0.06);color:#aab;
    border:1px solid rgba(255,255,255,0.08);border-radius:5px;
    font-size:11px;white-space:nowrap;cursor:pointer;
    font-family:'SF Mono','Menlo','Consolas',monospace;flex-shrink:0;
    transition:all 0.12s;-webkit-tap-highlight-color:transparent;
    min-height:26px;
    display:flex;align-items:center;justify-content:center;
  }
  .qk:active{background:#e94560;color:#fff;border-color:#e94560;transform:scale(0.93)}
  .qk-stop{background:rgba(251,191,36,0.12);color:#fbbf24;border-color:rgba(251,191,36,0.25);font-weight:700}
  .qk-stop:active{background:#fbbf24;color:#000;border-color:#fbbf24}
  .qk-paste{background:rgba(96,165,250,0.12);color:#60a5fa;border-color:rgba(96,165,250,0.25)}
  .qk-paste:active{background:#60a5fa;color:#000;border-color:#60a5fa}
  .qk-bottom{background:rgba(34,211,238,0.12);color:#22d3ee;border-color:rgba(34,211,238,0.25)}
  .qk-bottom:active{background:#22d3ee;color:#000;border-color:#22d3ee}
  .qk-arrow{background:rgba(168,85,247,0.12);color:#a855f7;border-color:rgba(168,85,247,0.25);min-width:36px;padding:6px 8px}
  .qk-arrow:active{background:#a855f7;color:#fff;border-color:#a855f7}
  .qk-nav{min-width:86px}
  .qk-backspace{min-width:46px;padding:4px 10px;font-family:inherit}
  .qk-backspace svg{width:18px;height:18px;display:block}
}

/* Upload button */
.upload-btn{
  font-size:14px;padding:2px 8px;border-radius:10px;cursor:pointer;
  border:1px solid rgba(96,165,250,0.3);background:rgba(96,165,250,0.08);color:#888;
  transition:all 0.2s;display:flex;align-items:center;
}
.upload-btn:hover{border-color:rgba(96,165,250,0.5);color:#60a5fa}

/* Drag-over overlay */
#terminal-wrap.drag-over::after{
  content:'释放文件以上传';
  position:absolute;inset:0;z-index:20;
  display:flex;align-items:center;justify-content:center;
  background:rgba(13,19,38,0.8);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);
  border:2px dashed rgba(96,165,250,0.6);border-radius:8px;
  color:#60a5fa;font-size:18px;font-weight:600;
  pointer-events:none;
}

/* Toast */
.toast{
  position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
  padding:8px 20px;border-radius:20px;font-size:13px;
  color:#fff;opacity:0;transition:opacity 0.3s;
  pointer-events:none;z-index:100;white-space:nowrap;
  max-width:90vw;overflow:hidden;text-overflow:ellipsis;
}
.toast.show{opacity:1}
.toast.success{background:rgba(74,222,128,0.85)}
.toast.error{background:rgba(239,68,68,0.85)}
.toast.info{background:rgba(96,165,250,0.85)}
</style></head>
<body>
<div id="app">
  <input type="file" id="file-input" multiple style="display:none">
  <div class="toast" id="toast"></div>
  <div id="header"></div>
  <div id="terminal-wrap">
    <div id="overlay">
      <div class="msg">Connection lost</div>
      <button id="reconnect-btn">Reconnect</button>
    </div>
  </div>
  <div id="mobile-bar">
    <div class="mobile-row mobile-row-main">
      <button class="qk" id="btn-enter">Enter</button>
      <button class="qk qk-backspace" id="btn-backspace" aria-label="Backspace">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="currentColor" d="M20 5H9L3 12l6 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm-2.59 9L19 15.59 17.59 17 16 15.41 14.41 17 13 15.59 14.59 14 13 12.41 14.41 11 16 12.59 17.59 11 19 12.41 17.41 14Z"/>
        </svg>
      </button>
      <button class="qk qk-paste" id="btn-paste">Paste</button>
      <button class="qk qk-stop" id="btn-ctrlc">Ctrl+C</button>
      <button class="qk" id="btn-del">Del</button>
      <button class="qk" id="btn-newline">换行</button>
      <button class="qk qk-bottom" id="btn-bottom">底部</button>
    </div>
    <div class="mobile-row mobile-row-secondary">
      <button class="qk qk-nav" id="btn-tab">Tab</button>
      <button class="qk qk-nav" id="btn-shift-tab">Shift+Tab</button>
    </div>
    <div class="mobile-row mobile-row-arrows">
      <div class="arrow-pad">
        <button class="qk qk-arrow" id="btn-up">↑</button>
        <button class="qk qk-arrow" id="btn-left">←</button>
        <button class="qk qk-arrow" id="btn-down">↓</button>
        <button class="qk qk-arrow" id="btn-right">→</button>
      </div>
    </div>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
<script>
var TABS = ${TABS_JSON};
var activeTab = TABS[0].id;
var ws = null;
var reconnectAttempts = 0;
var maxReconnect = 10;
var reconnectTimer = null;

var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 768);

// ===== Build header tabs =====
var headerEl = document.getElementById('header');
TABS.forEach(function(t) {
  var el = document.createElement('div');
  el.className = 'tab' + (t.id === activeTab ? ' active' : '');
  el.textContent = t.label;
  el.dataset.tab = t.id;
  el.onclick = function() { switchTab(t.id); };
  headerEl.appendChild(el);
});
var rightEl = document.createElement('div');
rightEl.className = 'header-right';
rightEl.innerHTML = '<button class="upload-btn" id="upload-btn" title="Upload files">\\u{1F4CE}</button><button class="yolo-btn" id="yolo-btn">YOLO</button><span id="status-text" class="status-text">Connecting</span><span id="status-dot" class="dot"></span>';
headerEl.appendChild(rightEl);

// ===== Build xterm instances =====
var wrapEl = document.getElementById('terminal-wrap');
var terms = {};
var fitAddons = {};
var panels = {};

function getTermTextarea(term) {
  if (!term) return null;
  if (term.textarea) return term.textarea;
  if (term.element) return term.element.querySelector('.xterm-helper-textarea');
  return null;
}

function suppressNativeCaret(term) {
  var textarea = getTermTextarea(term);
  if (!textarea) return;
  textarea.style.caretColor = 'transparent';
  textarea.style.color = 'transparent';
  textarea.style.background = 'transparent';
  textarea.setAttribute('autocapitalize', 'off');
  textarea.setAttribute('autocomplete', 'off');
  textarea.setAttribute('autocorrect', 'off');
  textarea.spellcheck = false;
}

function blurTerm(term) {
  if (!term) return;
  if (typeof term.blur === 'function') {
    term.blur();
    return;
  }
  var textarea = getTermTextarea(term);
  if (textarea && typeof textarea.blur === 'function') textarea.blur();
}

function syncActiveTermFocus(shouldFocus) {
  Object.keys(terms).forEach(function(id) {
    if (id !== activeTab) blurTerm(terms[id]);
  });
  suppressNativeCaret(terms[activeTab]);
  if (shouldFocus && terms[activeTab]) terms[activeTab].focus();
}

TABS.forEach(function(t) {
  var panel = document.createElement('div');
  panel.className = 'term-panel' + (t.id === activeTab ? ' active' : '');
  panel.id = 'panel-' + t.id;
  wrapEl.insertBefore(panel, document.getElementById('overlay'));
  panels[t.id] = panel;

  var term = new window.Terminal({
    cursorBlink: false,
    cursorStyle: 'bar',
    cursorWidth: 1,
    cursorInactiveStyle: 'none',
    fontSize: isMobile ? 12 : 14,
    fontFamily: "'Cascadia Code','Fira Code','JetBrains Mono','Menlo','Consolas','Symbols Nerd Font Mono',monospace",
    lineHeight: isMobile ? 1.1 : 1.15,
    theme: {
      background: '#1a1a2e',
      foreground: '#e0e0e0',
      cursor: 'transparent',
      cursorAccent: 'transparent',
      selectionBackground: 'rgba(233,69,96,0.25)',
      selectionForeground: '#fff',
      black: '#1a1a2e', red: '#e94560', green: '#4ade80', yellow: '#fbbf24',
      blue: '#60a5fa', magenta: '#c084fc', cyan: '#22d3ee', white: '#e0e0e0',
      brightBlack: '#4a4a6a', brightRed: '#ff6b81', brightGreen: '#6aff96',
      brightYellow: '#ffe066', brightBlue: '#82bdff', brightMagenta: '#d8a8ff',
      brightCyan: '#5aeaea', brightWhite: '#ffffff',
    },
    scrollback: 10000,
    allowProposedApi: true,
    convertEol: true,
  });

  var fit = new window.FitAddon.FitAddon();
  term.loadAddon(fit);
  if (window.WebLinksAddon) term.loadAddon(new window.WebLinksAddon.WebLinksAddon());
  term.open(panel);
  suppressNativeCaret(term);
  fit.fit();
  terms[t.id] = term;
  fitAddons[t.id] = fit;

  // Keep desktop physical-keyboard behavior on xterm's native path.
  // Only special-case Shift+Enter because we want it to send a literal newline.
  (function(tabId, t) {
    t.attachCustomKeyEventHandler(function(e) {
      if (e.type !== 'keydown') return true;
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        sendRaw(tabId, '\\n');
        return false;
      }
      return true;
    });
  })(t.id, term);

  // Keyboard input (both desktop and mobile)
  term.onData(function(data) {
    sendRaw(t.id, data);
  });
});

// ===== Fit =====
function doFit() {
  try {
    var fit = fitAddons[activeTab];
    if (fit) {
      fit.fit();
      var t = terms[activeTab];
      if (ws && ws.readyState === 1 && t) {
        ws.send(JSON.stringify({ type: 'resize', tab: activeTab, cols: t.cols, rows: t.rows }));
      }
    }
  } catch(e) {}
}
requestAnimationFrame(doFit);
setTimeout(doFit, 100);
setTimeout(doFit, 500);
if (document.fonts && document.fonts.ready) document.fonts.ready.then(doFit);

var resizeTimer;
window.addEventListener('resize', function() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(doFit, 150);
});

// ===== Tab switching =====
function switchTab(tabId) {
  if (activeTab === tabId) return;
  activeTab = tabId;
  syncActiveTermFocus(false);
  document.querySelectorAll('.tab').forEach(function(el) {
    el.classList.toggle('active', el.dataset.tab === tabId);
  });
  Object.keys(panels).forEach(function(id) {
    panels[id].classList.toggle('active', id === tabId);
  });
  setTimeout(function() {
    fitAddons[tabId].fit();
    syncActiveTermFocus(!isMobile);
  }, 50);
  if (ws && ws.readyState === 1) {
    var t = terms[tabId];
    ws.send(JSON.stringify({ type: 'activate', tab: tabId, cols: t.cols, rows: t.rows }));
  }
}

// ===== WebSocket =====
var dotEl = document.getElementById('status-dot');
var textEl = document.getElementById('status-text');
var overlayEl = document.getElementById('overlay');

function setStatus(connected) {
  if (connected) {
    dotEl.classList.add('on');
    textEl.classList.add('on');
    textEl.textContent = 'Connected';
  } else {
    dotEl.classList.remove('on');
    textEl.classList.remove('on');
    textEl.textContent = 'Disconnected';
  }
}

function connect() {
  var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host + '/ws');
  textEl.textContent = 'Connecting';

  ws.onopen = function() {
    setStatus(true);
    overlayEl.classList.remove('show');
    reconnectAttempts = 0;
    doFit();
    var t = terms[activeTab];
    ws.send(JSON.stringify({ type: 'activate', tab: activeTab, cols: t.cols, rows: t.rows }));
  };

  ws.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'output' || msg.type === 'scrollback') {
        if (terms[msg.tab]) terms[msg.tab].write(msg.data);
      } else if (msg.type === 'clear') {
        if (terms[msg.tab]) terms[msg.tab].clear();
      } else if (msg.type === 'yolo') {
        var yoloBtn = document.getElementById('yolo-btn');
        if (yoloBtn) yoloBtn.classList.toggle('on', msg.yolo);
      } else if (msg.type === 'exit') {
        if (terms[msg.tab]) {
          terms[msg.tab].write('\\r\\n\\x1b[31m[Session ended]\\x1b[0m\\r\\n');
        }
      }
    } catch(ex) {}
  };

  ws.onclose = function() {
    setStatus(false);
    if (reconnectAttempts < maxReconnect) {
      reconnectAttempts++;
      reconnectTimer = setTimeout(connect, 3000);
    } else {
      overlayEl.classList.add('show');
    }
  };

  ws.onerror = function() {};
}

document.getElementById('reconnect-btn').addEventListener('click', function() {
  clearTimeout(reconnectTimer);
  reconnectAttempts = 0;
  if (ws) { try { ws.close(); } catch(e) {} }
  connect();
});

function sendRaw(tabId, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'input', tab: tabId, data: data }));
  }
}

function scrollActiveTabToBottom() {
  var term = terms[activeTab];
  if (term) term.scrollToBottom();
}

connect();

// ===== YOLO button =====
document.getElementById('yolo-btn').addEventListener('click', function() {
  var btn = this;
  var isOn = btn.classList.contains('on');
  var newYolo = !isOn;
  var yoloTab = (activeTab === 'codex') ? 'codex' : 'claude';
  var yoloLabel = (yoloTab === 'codex') ? 'Codex' : 'Claude Code';
  var yoloFlag = (yoloTab === 'codex') ? '--yolo' : '--dangerously-skip-permissions';
  if (newYolo && !confirm('开启 YOLO 模式？\\n\\n' + yoloLabel + ' 将自动批准所有操作（' + yoloFlag + '）。\\n确认后会重启当前 ' + yoloLabel + ' 会话。')) return;
  if (!newYolo && !confirm('关闭 YOLO 模式？\\n\\n确认后会重启当前 ' + yoloLabel + ' 会话。')) return;
  var t = terms[yoloTab];
  if (ws && ws.readyState === 1 && t) {
    ws.send(JSON.stringify({ type: 'restart', tab: yoloTab, yolo: newYolo, cols: t.cols, rows: t.rows }));
  }
});

// ===== Mobile =====
if (isMobile) {
  var appEl = document.getElementById('app');

  // --- Keyboard handling via visualViewport ---
  if (window.visualViewport) {
    var lastVH = window.visualViewport.height;
    function adjustForKeyboard() {
      var vh = window.visualViewport.height;
      appEl.style.height = vh + 'px';
      // Scroll terminal to bottom when keyboard opens
      if (vh < lastVH) {
        setTimeout(scrollActiveTabToBottom, 50);
      }
      lastVH = vh;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doFit, 80);
    }
    window.visualViewport.addEventListener('resize', adjustForKeyboard);
    window.visualViewport.addEventListener('scroll', function() { window.scrollTo(0, 0); });
    adjustForKeyboard();
  }

  // --- Touch: scroll terminal + swipe to switch tabs ---
  var touchStartX = 0, touchStartY = 0, lastTouchY = 0, touchDir = null;
  var termWrap = document.getElementById('terminal-wrap');
  var SCROLL_SPEED = 1.5; // lines per 20px of touch movement

  termWrap.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) return;
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    lastTouchY = touchStartY;
    touchDir = null; // undecided
  }, { passive: true });

  termWrap.addEventListener('touchmove', function(e) {
    if (e.touches.length !== 1) return;
    var curY = e.touches[0].clientY;
    var curX = e.touches[0].clientX;
    var dy = curY - touchStartY;
    var dx = curX - touchStartX;

    // Decide direction on first significant move
    if (!touchDir) {
      if (Math.abs(dy) > 8 || Math.abs(dx) > 8) {
        touchDir = Math.abs(dy) > Math.abs(dx) ? 'v' : 'h';
      } else return;
    }

    if (touchDir === 'v') {
      // Vertical: scroll terminal
      var delta = lastTouchY - curY;
      var lines = Math.round(delta / 20 * SCROLL_SPEED);
      if (lines !== 0) {
        terms[activeTab].scrollLines(lines);
        lastTouchY = curY;
      }
      e.preventDefault();
    }
  }, { passive: false });

  termWrap.addEventListener('touchend', function(e) {
    if (touchDir !== 'h') return;
    var dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) < 60) return;
    var idx = TABS.findIndex(function(t) { return t.id === activeTab; });
    if (dx < 0 && idx < TABS.length - 1) switchTab(TABS[idx + 1].id);
    else if (dx > 0 && idx > 0) switchTab(TABS[idx - 1].id);
  }, { passive: true });

  // --- Ctrl+C button ---
  document.getElementById('btn-ctrlc').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, String.fromCharCode(3));
  }, { passive: false });

  // --- Enter button ---
  document.getElementById('btn-enter').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, String.fromCharCode(13));
  }, { passive: false });

  // --- Backspace button ---
  document.getElementById('btn-backspace').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, '\x7f');
  }, { passive: false });

  // --- Shift+Enter button: send newline ---
  document.getElementById('btn-newline').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, '\\n');
  }, { passive: false });

  // --- Scroll-to-bottom button ---
  document.getElementById('btn-bottom').addEventListener('touchstart', function(e) {
    e.preventDefault();
    scrollActiveTabToBottom();
  }, { passive: false });

  // --- Tab button ---
  document.getElementById('btn-tab').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, String.fromCharCode(9));
  }, { passive: false });

  // --- Shift+Tab button ---
  document.getElementById('btn-shift-tab').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, '\x1b[Z');
  }, { passive: false });

  // --- Delete button ---
  document.getElementById('btn-del').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, '\x1b[3~');
  }, { passive: false });

  // --- Paste button: read clipboard and send to terminal ---
  document.getElementById('btn-paste').addEventListener('click', function(e) {
    e.preventDefault();
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function(text) {
        if (text) sendRaw(activeTab, text);
      }).catch(function() {});
    }
  });

  // --- Arrow buttons ---
  document.getElementById('btn-up').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, '\x1b[A');
  }, { passive: false });
  document.getElementById('btn-down').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, '\x1b[B');
  }, { passive: false });
  document.getElementById('btn-right').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, '\x1b[C');
  }, { passive: false });
  document.getElementById('btn-left').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendRaw(activeTab, '\x1b[D');
  }, { passive: false });

  // --- Tap terminal to focus xterm (show keyboard) ---
  termWrap.addEventListener('touchend', function(e) {
    if (touchDir === 'v' || touchDir === 'h') return; // was scrolling/swiping
    if (e.target.closest('#mobile-bar') || e.target.closest('#overlay')) return;
    syncActiveTermFocus(true);
  });
}

// Desktop focus
if (!isMobile) {
  syncActiveTermFocus(true);
  document.addEventListener('click', function(e) {
    if (!e.target.closest('button') && !e.target.closest('.tab') && !e.target.closest('input') && !e.target.closest('textarea')) {
      syncActiveTermFocus(true);
    }
  });
}

// ===== File Upload =====
var toastEl = document.getElementById('toast');
var toastTimer = null;
function showToast(msg, type, duration) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.className = 'toast show ' + (type || 'info');
  toastTimer = setTimeout(function() { toastEl.className = 'toast'; }, duration || 3000);
}

var MAX_UPLOAD_MB = 50;
function uploadFile(file) {
  if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
    var sizeMB = (file.size / 1024 / 1024).toFixed(1);
    return Promise.reject(new Error(file.name + ' 太大（' + sizeMB + 'MB），最大 ' + MAX_UPLOAD_MB + 'MB'));
  }
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    var encodedName = encodeURIComponent(file.name);
    xhr.open('POST', '/upload?name=' + encodedName);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        var pct = Math.round(e.loaded / e.total * 100);
        showToast(file.name + ' ' + pct + '%', 'info', 30000);
      }
    };
    xhr.onload = function() {
      if (xhr.status === 200) {
        try { resolve(JSON.parse(xhr.responseText)); } catch(e) { resolve({}); }
      } else {
        reject(new Error(xhr.responseText || 'Upload failed'));
      }
    };
    xhr.onerror = function() { reject(new Error('Network error')); };
    xhr.send(file);
  });
}

function uploadFiles(files) {
  var list = Array.from(files);
  if (!list.length) return;
  var idx = 0;
  var snippets = [];

  function normalizeAbsolutePath(filePath) {
    return String(filePath || '').replace(/\\\\/g, '/');
  }

  function buildFileSnippet(filePath) {
    return '[file](' + normalizeAbsolutePath(filePath) + ')';
  }

  function next() {
    if (idx >= list.length) {
      showToast(list.length > 1 ? list.length + ' files uploaded and inserted' : list[0].name + ' uploaded and inserted', 'success');
      if (snippets.length) {
        var text = snippets.join(' ') + ' ';
        sendRaw(activeTab, text);
      }
      return;
    }
    var f = list[idx];
    var label = list.length > 1 ? '(' + (idx + 1) + '/' + list.length + ') ' : '';
    showToast(label + 'Uploading ' + f.name + '...', 'info', 30000);
    uploadFile(f).then(function(result) {
      var uploadedPath = result && (result.absolutePath || result.path);
      if (uploadedPath) snippets.push(buildFileSnippet(uploadedPath));
      idx++;
      next();
    }).catch(function(err) {
      showToast('Failed: ' + f.name + ' - ' + err.message, 'error', 5000);
    });
  }
  next();
}

// Upload button click
var fileInput = document.getElementById('file-input');
document.getElementById('upload-btn').addEventListener('click', function() {
  fileInput.click();
});
fileInput.addEventListener('change', function() {
  if (fileInput.files.length) uploadFiles(fileInput.files);
  fileInput.value = '';
});

// Drag and drop
var dragCounter = 0;
var termWrapEl = document.getElementById('terminal-wrap');
termWrapEl.addEventListener('dragenter', function(e) {
  e.preventDefault();
  dragCounter++;
  termWrapEl.classList.add('drag-over');
});
termWrapEl.addEventListener('dragleave', function(e) {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) { dragCounter = 0; termWrapEl.classList.remove('drag-over'); }
});
termWrapEl.addEventListener('dragover', function(e) {
  e.preventDefault();
});
termWrapEl.addEventListener('drop', function(e) {
  e.preventDefault();
  dragCounter = 0;
  termWrapEl.classList.remove('drag-over');
  if (e.dataTransfer.files.length) uploadFiles(e.dataTransfer.files);
});
</script>
</body></html>`;

// ===== Cookie helpers =====
function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function isAuthed(req) {
  return parseCookies(req)['cct'] === TOKEN;
}

// ===== HTTP server =====
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost`);

  if (url.pathname === '/health') {
    res.writeHead(200);
    res.end('ok');
    return;
  }

  if (url.pathname === '/' || url.pathname === '/login') {
    if (isAuthed(req)) { res.writeHead(302, { Location: '/terminal' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(LOGIN_HTML);
    return;
  }

  if (url.pathname === '/auth' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { token } = JSON.parse(body);
        if (token === TOKEN) {
          res.writeHead(200, {
            'Set-Cookie': `cct=${TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
            'Content-Type': 'application/json'
          });
          res.end('{"ok":true}');
        } else {
          res.writeHead(401);
          res.end('{"ok":false}');
        }
      } catch {
        res.writeHead(400);
        res.end('bad request');
      }
    });
    return;
  }

  if (url.pathname === '/terminal') {
    if (!isAuthed(req)) { res.writeHead(302, { Location: '/' }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TERMINAL_HTML);
    return;
  }

  // File upload
  if (url.pathname === '/upload' && req.method === 'POST') {
    if (!isAuthed(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
    const name = url.searchParams.get('name');
    if (!name) { res.writeHead(400); res.end('Missing name parameter'); return; }
    const UPLOAD_DIR = path.join(CWD, '.claude', 'uploads');
    const dir = url.searchParams.get('dir') || '';
    // Path safety: reject .. and absolute paths
    if (name.includes('..') || dir.includes('..')) { res.writeHead(400); res.end('Invalid path: contains ..'); return; }
    if (path.isAbsolute(name) || path.isAbsolute(dir)) { res.writeHead(400); res.end('Invalid path: absolute paths not allowed'); return; }
    const targetDir = path.resolve(UPLOAD_DIR, dir);
    const targetPath = path.resolve(targetDir, name);
    // Ensure resolved path is within UPLOAD_DIR
    if (!targetPath.startsWith(path.resolve(UPLOAD_DIR) + path.sep) && targetPath !== path.resolve(UPLOAD_DIR)) {
      res.writeHead(400); res.end('Invalid path: outside upload directory'); return;
    }
    // Content-Length pre-check
    const contentLength = parseInt(req.headers['content-length'] || '0');
    if (contentLength > MAX_UPLOAD_SIZE) { res.writeHead(413); res.end('File too large (max 100MB)'); return; }
    // Create directory if needed
    fs.mkdirSync(targetDir, { recursive: true });
    const ws = fs.createWriteStream(targetPath);
    let received = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_UPLOAD_SIZE && !aborted) {
        aborted = true;
        req.destroy();
        ws.destroy();
        try { fs.unlinkSync(targetPath); } catch {}
        res.writeHead(413);
        res.end('File too large (max 100MB)');
      }
    });
    req.pipe(ws);
    ws.on('finish', () => {
      if (aborted) return;
      const relPath = path.relative(CWD, targetPath).split(path.sep).join('/');
      const absolutePath = targetPath.split(path.sep).join('/');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: relPath, absolutePath, size: received }));
    });
    ws.on('error', (err) => {
      if (aborted) return;
      res.writeHead(500);
      res.end('Write error: ' + err.message);
    });
    return;
  }

  // Legacy compat
  const match = url.pathname.match(/^\/t\/([^/]+)$/);
  if (match && match[1] === TOKEN) {
    res.writeHead(302, { Location: '/terminal', 'Set-Cookie': `cct=${TOKEN}; HttpOnly; SameSite=Strict; Path=/` });
    res.end();
    return;
  }

  res.writeHead(403);
  res.end('Forbidden');
});

// ===== WebSocket server =====
const wss = new WebSocketServer({ server });

wss.on('connection', (ws, req) => {
  if (!isAuthed(req)) {
    ws.close(1008, 'Unauthorized');
    return;
  }

  clients.add(ws);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'activate') {
        const tabId = msg.tab;
        const state = tabState[tabId];
        if (!state) return;
        if (!state.pty && state.status !== 'error') {
          spawnTab(tabId, msg.cols, msg.rows);
        } else if (state.pty && msg.cols && msg.rows) {
          state.pty.resize(Math.max(msg.cols, 10), Math.max(msg.rows, 5));
        }
        if (state.scrollback) {
          ws.send(JSON.stringify({ type: 'scrollback', tab: tabId, data: state.scrollback }));
        }
        ws.send(JSON.stringify({ type: 'status', tab: tabId, status: state.status }));
      }

      if (msg.type === 'restart') {
        const tabId = msg.tab;
        const tab = TABS.find(t => t.id === tabId);
        const state = tabState[tabId];
        if (!tab || !state) return;
        // Kill existing pty
        if (state.pty) {
          state.pty.kill();
          state.pty = null;
        }
        state.scrollback = '';
        state.status = 'idle';
        // Update args based on yolo flag
        if (msg.yolo !== undefined) {
          if (tab.cmd === 'claude') {
            const baseArgs = (tab.args || []).filter(a => a !== '--dangerously-skip-permissions');
            tab.args = msg.yolo ? [...baseArgs, '--dangerously-skip-permissions'] : baseArgs;
          } else if (tab.cmd === 'codex') {
            const baseArgs = (tab.args || []).filter(a => a !== '--yolo');
            tab.args = msg.yolo ? [...baseArgs, '--yolo'] : baseArgs;
          }
        }
        // Clear terminal on all clients
        broadcast({ type: 'clear', tab: tabId });
        // Respawn
        spawnTab(tabId, msg.cols, msg.rows);
        // Send yolo state back
        const isYolo = (tab.args || []).includes('--dangerously-skip-permissions') || (tab.args || []).includes('--yolo');
        broadcast({ type: 'yolo', tab: tabId, yolo: isYolo });
      }

      if (msg.type === 'input') {
        const state = tabState[msg.tab];
        if (state && state.pty) state.pty.write(msg.data);
      }

      if (msg.type === 'resize') {
        const state = tabState[msg.tab];
        if (state && state.pty) {
          state.pty.resize(Math.max(msg.cols || 80, 10), Math.max(msg.rows || 24, 5));
        }
      }
    } catch {}
  });

  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[web-terminal] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[web-terminal] Token: ${TOKEN}`);
  console.log(`[web-terminal] Local URL: http://127.0.0.1:${PORT}/t/${TOKEN}`);
  console.log(`[web-terminal] Tabs: ${TABS.map(t => t.label).join(', ')}`);
});

process.on('SIGINT', () => {
  for (const state of Object.values(tabState)) {
    if (state.pty) state.pty.kill();
  }
  process.exit(0);
});

