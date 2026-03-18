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
const RUNTIME_TABS_PATH = path.resolve(CWD, '.claude', 'skills', 'web-terminal', 'runtime-tabs.json');

// Tab definitions
const configuredTabs = [
  { id: 'claude', label: 'Claude Code', cmd: 'claude', args: ['--continue'] },
  { id: 'codex', label: 'Codex', cmd: 'codex', args: [] },
];
const EXTRA_TAB_TEMPLATES = [
  { id: 'pwsh', label: 'pwsh', cmd: 'pwsh', args: [] },
];

if (process.env.WEB_TERMINAL_TABS) {
  try {
    const custom = JSON.parse(process.env.WEB_TERMINAL_TABS);
    configuredTabs.length = 0;
    configuredTabs.push(...custom);
  } catch (e) {
    console.error('[web-terminal] Invalid WEB_TERMINAL_TABS JSON, using defaults');
  }
}

function cloneTab(source, overrides = {}) {
  return {
    id: overrides.id || source.id,
    label: overrides.label || source.label,
    cmd: source.cmd,
    args: [...(source.args || [])],
    templateId: overrides.templateId || source.templateId || source.id,
    baseLabel: overrides.baseLabel || source.baseLabel || source.label,
  };
}

const TABS = configuredTabs.map((tab) => cloneTab(tab));
const DEFAULT_TAB_IDS = new Set(TABS.map((tab) => tab.id));
const TAB_TEMPLATES = TABS.map((tab) => cloneTab(tab));
for (const tab of EXTRA_TAB_TEMPLATES) {
  if (!TAB_TEMPLATES.some(existing => existing.id === tab.id)) {
    TAB_TEMPLATES.push(cloneTab(tab));
  }
}

function getTab(tabId) {
  return TABS.find(t => t.id === tabId) || null;
}

function getTabTemplate(templateId) {
  return TAB_TEMPLATES.find(t => t.id === templateId) || null;
}

function ensureTabState(tabId) {
  if (!tabState[tabId]) {
    tabState[tabId] = { pty: null, scrollback: '', status: 'idle' };
  }
  return tabState[tabId];
}

function serializeTab(tab) {
  return {
    id: tab.id,
    label: tab.label,
    templateId: tab.templateId || tab.id,
    baseLabel: tab.baseLabel || tab.label,
    isDefault: DEFAULT_TAB_IDS.has(tab.id),
  };
}

function serializeTabTemplates() {
  return TAB_TEMPLATES.map(serializeTab);
}

function sanitizeTabId(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function sanitizeTabLabel(value, fallback) {
  const next = String(value || '').trim().replace(/\s+/g, ' ');
  return (next || fallback || 'New Tab').slice(0, 40);
}

function normalizeTabArgs(value) {
  return Array.isArray(value)
    ? value.map(arg => String(arg)).filter(arg => arg.length > 0)
    : [];
}

function stripRuntimeResumeArgs(args) {
  return normalizeTabArgs(args).filter(arg => arg !== '--continue');
}

function normalizePersistedRuntimeTab(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = sanitizeTabId(raw.id);
  if (!id || DEFAULT_TAB_IDS.has(id)) return null;
  const cmd = typeof raw.cmd === 'string' ? raw.cmd.trim() : '';
  if (!cmd) return null;
  const label = sanitizeTabLabel(raw.label, raw.baseLabel || raw.templateId || cmd);
  const baseLabel = sanitizeTabLabel(raw.baseLabel, label);
  const templateId = sanitizeTabId(raw.templateId) || id;
  return {
    id,
    label,
    cmd,
    args: stripRuntimeResumeArgs(raw.args),
    templateId,
    baseLabel,
  };
}

function listRuntimeTabs() {
  return TABS.filter(tab => !DEFAULT_TAB_IDS.has(tab.id));
}

function removeRuntimeTab(tabId) {
  if (DEFAULT_TAB_IDS.has(tabId)) return { error: 'Default tab cannot be deleted' };
  const index = TABS.findIndex(tab => tab.id === tabId);
  if (index === -1) return { error: 'Tab not found' };
  const [tab] = TABS.splice(index, 1);
  const state = tabState[tabId];
  if (state && state.pty) {
    try { state.pty.kill(); } catch {}
  }
  delete tabState[tabId];
  persistRuntimeTabs();
  return { tabId: tab.id };
}

function renameTab(tabId, nextLabel) {
  const tab = getTab(tabId);
  if (!tab) return { error: 'Tab not found' };
  const label = sanitizeTabLabel(nextLabel, tab.label);
  if (!label) return { error: 'Invalid tab label' };
  tab.label = label;
  persistRuntimeTabs();
  return { tab };
}

function persistRuntimeTabs() {
  const defaultLabels = {};
  for (const tab of TABS) {
    if (!DEFAULT_TAB_IDS.has(tab.id)) continue;
    const configured = configuredTabs.find(item => item.id === tab.id);
    const originalLabel = configured ? configured.label : tab.baseLabel || tab.label;
    if (tab.label !== originalLabel) defaultLabels[tab.id] = tab.label;
  }
  const runtimeTabs = listRuntimeTabs().map(tab => ({
    id: tab.id,
    label: tab.label,
    cmd: tab.cmd,
    args: [...(tab.args || [])],
    templateId: tab.templateId || tab.id,
    baseLabel: tab.baseLabel || tab.label,
  }));
  try {
    fs.mkdirSync(path.dirname(RUNTIME_TABS_PATH), { recursive: true });
    fs.writeFileSync(RUNTIME_TABS_PATH, JSON.stringify({
      version: 2,
      defaultLabels,
      runtimeTabs,
    }, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.error('[web-terminal] Failed to persist runtime tabs:', e.message);
  }
}

function loadPersistedRuntimeTabs() {
  if (!fs.existsSync(RUNTIME_TABS_PATH)) return [];
  try {
    const raw = fs.readFileSync(RUNTIME_TABS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return {
        defaultLabels: {},
        runtimeTabs: parsed.map(normalizePersistedRuntimeTab).filter(Boolean),
      };
    }
    const defaultLabels = {};
    if (parsed && typeof parsed.defaultLabels === 'object' && parsed.defaultLabels) {
      for (const [tabId, label] of Object.entries(parsed.defaultLabels)) {
        if (!DEFAULT_TAB_IDS.has(tabId)) continue;
        defaultLabels[tabId] = sanitizeTabLabel(label, label);
      }
    }
    const runtimeTabs = Array.isArray(parsed && parsed.runtimeTabs)
      ? parsed.runtimeTabs.map(normalizePersistedRuntimeTab).filter(Boolean)
      : [];
    return { defaultLabels, runtimeTabs };
  } catch (e) {
    console.error('[web-terminal] Failed to load runtime tabs:', e.message);
    return { defaultLabels: {}, runtimeTabs: [] };
  }
}

const persistedTabs = loadPersistedRuntimeTabs();
for (const tab of TABS) {
  if (persistedTabs.defaultLabels[tab.id]) tab.label = persistedTabs.defaultLabels[tab.id];
}
for (const tab of persistedTabs.runtimeTabs) {
  if (!getTab(tab.id)) TABS.push(cloneTab(tab));
}

function registerRuntimeTabFromSource(source, options = {}) {
  if (!source) return { error: 'Missing tab source' };
  const id = sanitizeTabId(options.id);
  if (!id) return { error: 'Invalid tab id' };
  if (getTab(id)) return { error: 'Tab already exists' };
  const tab = cloneTab(source, {
    id,
    label: sanitizeTabLabel(options.label, source.baseLabel || source.label),
    templateId: source.templateId || source.id,
    baseLabel: source.baseLabel || source.label,
  });
  tab.args = stripRuntimeResumeArgs(tab.args);
  TABS.push(tab);
  ensureTabState(tab.id);
  persistRuntimeTabs();
  return { tab };
}

// Per-tab state
const tabState = {};
for (const tab of TABS) {
  ensureTabState(tab.id);
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
  const tab = getTab(tabId);
  const state = ensureTabState(tabId);
  if (!tab || !state || state.pty) return;

  let spawnCmd, spawnArgs;
  const isPowerShellTab = tab.cmd === 'pwsh' || tab.cmd === 'pwsh.exe';
  if (process.platform === 'win32') {
    if (isPowerShellTab) {
      spawnCmd = 'pwsh.exe';
      spawnArgs = ['-NoLogo', '-NoExit'];
    } else {
      spawnCmd = 'pwsh.exe';
      const initCmd = `[Console]::InputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${tab.cmd} ${tab.args.join(' ')}`;
      spawnArgs = ['-NoLogo', '-NoExit', '-Command', initCmd];
    }
  } else {
    if (isPowerShellTab) {
      spawnCmd = 'pwsh';
      spawnArgs = ['-NoLogo'];
    } else {
      spawnCmd = 'bash';
      spawnArgs = ['-c', `${tab.cmd} ${tab.args.join(' ')}`];
    }
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
const TABS_JSON = JSON.stringify(TABS.map(serializeTab));
const TAB_TEMPLATES_JSON = JSON.stringify(serializeTabTemplates());

const TERMINAL_HTML = `<!DOCTYPE html>
<html lang="zh"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="mobile-web-app-capable" content="yes">
<link rel="manifest" href="/manifest.json">
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

#app{display:flex;flex-direction:column;position:fixed;inset:0}

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
.tab-label{display:block;overflow:hidden;text-overflow:ellipsis}
.tab.closable{gap:8px;padding-right:10px;max-width:220px}
.tab-close{
  width:18px;height:18px;border:none;border-radius:999px;cursor:pointer;
  display:flex;align-items:center;justify-content:center;flex:0 0 auto;
  background:rgba(255,255,255,0.04);color:inherit;font-size:12px;line-height:1;
  padding:0;transition:all 0.18s;
}
.tab-close:hover{background:rgba(255,255,255,0.1);color:#fff}
.tab-close:active{transform:scale(0.92)}
.tab.active{color:#e94560;border-bottom-color:#e94560}
.tab:active{opacity:0.7}
.header-right{
  margin-left:auto;display:flex;align-items:center;gap:6px;
  padding:0 12px;flex-shrink:0;
}
.tab-actions{position:relative;display:flex;align-items:center;gap:4px}
.tab-action-btn{
  min-width:28px;height:28px;padding:0 8px;border-radius:8px;cursor:pointer;
  border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);color:#b8bfd8;
  transition:all 0.18s;display:flex;align-items:center;justify-content:center;
  font-size:16px;line-height:1;
}
.tab-action-btn:hover{background:rgba(255,255,255,0.08);color:#fff;border-color:rgba(255,255,255,0.18)}
.tab-action-btn:active{transform:scale(0.95)}
.tab-action-btn.caret{font-size:12px;padding-top:1px}
.tab-template-menu{
  position:fixed;top:0;left:0;z-index:30;min-width:164px;max-width:min(220px,calc(100vw - 16px));
  max-height:calc(100dvh - 16px);overflow:auto;
  padding:6px;background:rgba(13,19,38,0.96);border:1px solid rgba(233,69,96,0.16);
  border-radius:10px;box-shadow:0 16px 32px rgba(0,0,0,0.35);
  display:none;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
  -webkit-overflow-scrolling:touch;touch-action:manipulation;
}
.tab-template-menu.show{display:block}
.tab-template-item{
  width:100%;border:none;background:transparent;color:#d7dcee;cursor:pointer;
  text-align:left;padding:9px 10px;border-radius:8px;font-size:13px;
  display:flex;align-items:center;justify-content:space-between;gap:10px;
  touch-action:manipulation;
}
.tab-template-item:hover{background:rgba(255,255,255,0.06)}
.tab-template-item small{color:#7d88ab;font-size:11px}
.dot{width:7px;height:7px;border-radius:50%;background:#f87171;flex-shrink:0;transition:background 0.3s}
.dot.on{background:#4ade80;box-shadow:0 0 6px rgba(74,222,128,0.5)}
.status-text{font-size:11px;color:#666;transition:color 0.3s}
.status-text.on{color:#4ade80}
#status-indicator{
  position:fixed;right:16px;bottom:16px;z-index:24;
  display:flex;align-items:center;gap:8px;
  padding:8px 12px;border-radius:999px;
  background:rgba(13,19,38,0.92);border:1px solid rgba(255,255,255,0.08);
  box-shadow:0 10px 24px rgba(0,0,0,0.28);
  pointer-events:none;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
.yolo-btn{
  font-size:11px;padding:2px 8px;border-radius:10px;cursor:pointer;
  border:1px solid rgba(251,191,36,0.3);background:rgba(251,191,36,0.08);color:#888;
  transition:all 0.2s;font-weight:700;letter-spacing:0.5px;
}
.yolo-btn:hover{border-color:rgba(251,191,36,0.5)}
.yolo-btn.on{background:rgba(251,191,36,0.2);color:#fbbf24;border-color:#fbbf24;text-shadow:0 0 8px rgba(251,191,36,0.4)}
/* Terminal area */
#terminal-wrap{flex:1;min-height:0;position:relative;overflow:hidden;padding-top:6px}
.term-panel{position:absolute;top:6px;right:0;bottom:0;left:0;display:none;overflow:hidden}
.term-panel.active{display:block}
.term-panel .xterm{height:100%!important}
.term-panel .xterm-screen{height:100%!important}
.term-panel,.term-panel .xterm,.term-panel .xterm-screen,.xterm-viewport{touch-action:pan-y}
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

#scroll-bottom-btn{
  position:absolute;right:16px;bottom:16px;z-index:6;
  width:42px;height:42px;border-radius:999px;
  border:1px solid rgba(148,163,184,0.35);
  background:rgba(248,250,252,0.96);color:#111827;
  display:flex;align-items:center;justify-content:center;
  cursor:pointer;box-shadow:0 10px 24px rgba(0,0,0,0.28);
  opacity:0;transform:translateY(10px) scale(0.96);pointer-events:none;
  transition:opacity 0.18s,transform 0.18s,box-shadow 0.18s,background 0.18s;
  backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);
}
#scroll-bottom-btn.show{opacity:1;transform:translateY(0) scale(1);pointer-events:auto}
#scroll-bottom-btn:hover{background:#fff;box-shadow:0 12px 28px rgba(0,0,0,0.34)}
#scroll-bottom-btn:active{transform:translateY(1px) scale(0.96)}
#scroll-bottom-btn svg{width:20px;height:20px;display:block}

/* Mobile bar — hidden on desktop */
#mobile-bar{display:none;flex-shrink:0}

@media (max-width:768px),(pointer:coarse){
  html,body{overscroll-behavior:none}
  #app{padding-bottom:0}
  #header{height:calc(44px + env(safe-area-inset-top,0));min-height:calc(44px + env(safe-area-inset-top,0));padding-top:env(safe-area-inset-top,0)}
  .tab{font-size:14px;padding:0 16px;min-width:44px;justify-content:center}
  .tab.closable{max-width:180px;padding-right:8px}
  .tab-close{width:20px;height:20px}
  #status-indicator{right:12px;bottom:calc(env(safe-area-inset-bottom,0px) + 4px);padding:7px 10px;gap:7px}
  .header-right{gap:4px;padding:0 8px}
  .tab-action-btn{min-width:26px;height:26px;padding:0 6px}
  .tab-template-menu{min-width:152px;max-width:calc(100vw - 12px)}
  #scroll-bottom-btn{right:12px;bottom:12px;width:44px;height:44px}

  #mobile-bar{
    display:flex;flex-direction:column;gap:6px;
    background:#111833;border-top:1px solid rgba(233,69,96,0.12);
    flex-shrink:0;
    padding:6px 12px;padding-bottom:env(safe-area-inset-bottom,6px);
  }
  .mobile-row{
    display:flex;align-items:center;gap:8px;
    overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none;
  }
  .mobile-row::-webkit-scrollbar{display:none}
  .mobile-row-secondary{justify-content:center;overflow:visible}
  .mobile-row-secondary #btn-esc{order:0}
  .mobile-row-arrows{justify-content:center;overflow:visible}
  .mobile-row-ctrlc{justify-content:center;overflow:visible;position:relative}
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
  #btn-enter{
    min-width:72px;min-height:30px;padding:5px 14px;
    font-size:12px;font-weight:700;
  }
  .qk-paste{background:rgba(96,165,250,0.12);color:#60a5fa;border-color:rgba(96,165,250,0.25)}
  .qk-paste:active{background:#60a5fa;color:#000;border-color:#60a5fa}
  .qk-upload{
    gap:5px;padding:4px 10px;
    background:rgba(96,165,250,0.12);color:#60a5fa;border-color:rgba(96,165,250,0.25);
  }
  .qk-upload:active{background:#60a5fa;color:#000;border-color:#60a5fa}
  .qk-arrow{background:rgba(168,85,247,0.12);color:#a855f7;border-color:rgba(168,85,247,0.25);min-width:36px;padding:6px 8px}
  .qk-arrow:active{background:#a855f7;color:#fff;border-color:#a855f7}
  .qk-nav{min-width:86px}
  .qk-backspace{
    min-width:46px;padding:4px 10px;font-family:inherit;
    background:linear-gradient(180deg,#4a4a4f 0%,#2c2c30 100%);
    color:#d4d4d8;
    border:1px solid #1a1a1e;
    border-radius:6px;
    box-shadow:0 1px 0 1px #0a0a0c,0 -1px 0 0 #5a5a5f inset,0 2px 4px rgba(0,0,0,0.4);
    text-shadow:0 1px 1px rgba(0,0,0,0.5);
    position:relative;
  }
  .qk-backspace:active{
    background:linear-gradient(180deg,#2c2c30 0%,#3a3a3f 100%);
    box-shadow:0 0 0 1px #0a0a0c,0 1px 2px rgba(0,0,0,0.3) inset;
    transform:translateY(1px) scale(0.97);
    color:#fff;border-color:#1a1a1e;
  }
  .qk-backspace svg{width:18px;height:18px;display:block}
  .mobile-row-ctrlc .yolo-btn{
    min-height:26px;padding:4px 12px;border-radius:5px;
    display:flex;align-items:center;justify-content:center;
  }
  #status-indicator.in-mobile-bar{
    position:absolute;right:0;top:50%;bottom:auto;left:auto;
    transform:translateY(-50%);
    padding:6px 10px;gap:6px;
    box-shadow:0 8px 18px rgba(0,0,0,0.22);
  }
  #status-indicator.in-mobile-bar .status-text{font-size:10px}
  #status-indicator.in-mobile-bar .dot{width:6px;height:6px}
  #header .upload-btn{display:none}
}

html[data-display-mode="standalone"] #mobile-bar{
  padding-bottom:0;
}
html[data-display-mode="standalone"] #scroll-bottom-btn{
  bottom:8px;
}
@media (display-mode: standalone) and (max-width:768px), (display-mode: standalone) and (pointer:coarse){
  #mobile-bar{padding-bottom:0}
  #scroll-bottom-btn{bottom:8px}
}

/* Upload button */
.upload-btn{
  min-width:30px;height:28px;padding:0 8px;border-radius:10px;cursor:pointer;
  border:1px solid rgba(96,165,250,0.3);background:rgba(96,165,250,0.08);color:#7fb7ff;
  transition:all 0.2s;display:flex;align-items:center;justify-content:center;
}
.upload-btn:hover{border-color:rgba(96,165,250,0.5);color:#60a5fa;background:rgba(96,165,250,0.12)}
.upload-btn svg,.qk-upload svg{width:14px;height:14px;display:block;flex-shrink:0}

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
    <button id="scroll-bottom-btn" type="button" title="滚动到底部" aria-label="滚动到底部">
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" d="M12 5v12m0 0l-5-5m5 5l5-5"/>
      </svg>
    </button>
  </div>
  <div id="mobile-bar">
    <div class="mobile-row mobile-row-main">
      <button class="qk" id="btn-enter">Enter</button>
      <button class="qk qk-nav" id="btn-tab">Tab</button>
      <button class="qk qk-paste" id="btn-paste">Paste</button>
      <button class="qk qk-backspace" id="btn-backspace" aria-label="Backspace">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M19 12H5m0 0l5-5m-5 5l5 5"/>
        </svg>
      </button>
      <button class="qk qk-upload upload-trigger" id="btn-upload" type="button" title="上传附件" aria-label="上传附件">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M21.44 11.05l-9.19 9.19a6 6 0 1 1-8.49-8.49l9.9-9.9a4 4 0 1 1 5.66 5.66l-10.6 10.61a2 2 0 1 1-2.83-2.83l9.9-9.9"/>
        </svg>
        <span>附件</span>
      </button>
    </div>
    <div class="mobile-row mobile-row-secondary">
      <button class="qk qk-nav" id="btn-esc">Esc</button>
      <button class="qk" id="btn-newline">换行</button>
      <button class="qk" id="btn-del">Del</button>
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
    <div class="mobile-row mobile-row-ctrlc">
      <button class="qk qk-stop" id="btn-ctrlc">Ctrl+C</button>
    </div>
  </div>
  <div id="status-indicator">
    <span id="status-text" class="status-text">Connecting</span>
    <span id="status-dot" class="dot"></span>
  </div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"></script>
<script>
var TABS = ${TABS_JSON};
var TAB_TEMPLATES = ${TAB_TEMPLATES_JSON};
var activeTab = TABS[0] ? TABS[0].id : null;
var ws = null;
var reconnectAttempts = 0;
var maxReconnect = 10;
var reconnectTimer = null;
var pendingCreatedTabId = null;

var isStandalonePwa = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  || window.navigator.standalone === true;
if (isStandalonePwa) document.documentElement.setAttribute('data-display-mode', 'standalone');

var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
  || (window.matchMedia('(pointer: coarse)').matches && window.innerWidth <= 768);

// ===== Build header tabs =====
var headerEl = document.getElementById('header');
var rightEl = document.createElement('div');
rightEl.className = 'header-right';
rightEl.innerHTML = '<div class="tab-actions"><button class="tab-action-btn plus" id="add-tab-btn" type="button" title="复制当前标签页" aria-label="复制当前标签页">+</button><button class="tab-action-btn caret" id="add-tab-menu-btn" type="button" title="从模板新建标签页" aria-label="从模板新建标签页">▾</button><div class="tab-template-menu" id="tab-template-menu"></div></div><button class="yolo-btn" id="yolo-btn">YOLO</button>';
headerEl.appendChild(rightEl);
// ===== Build xterm instances =====
var wrapEl = document.getElementById('terminal-wrap');
var scrollBottomBtnEl = document.getElementById('scroll-bottom-btn');
var addTabBtnEl = document.getElementById('add-tab-btn');
var addTabMenuBtnEl = document.getElementById('add-tab-menu-btn');
var tabTemplateMenuEl = document.getElementById('tab-template-menu');
var terms = {};
var fitAddons = {};
var panels = {};
var lastTouchActionAt = 0;
var lastRenameActionAt = 0;

document.body.appendChild(tabTemplateMenuEl);

function bindPress(el, handler) {
  el.addEventListener('touchend', function(e) {
    lastTouchActionAt = Date.now();
    e.preventDefault();
    e.stopPropagation();
    handler(e);
  }, { passive: false });
  el.addEventListener('click', function(e) {
    if (Date.now() - lastTouchActionAt < 450) return;
    e.preventDefault();
    e.stopPropagation();
    handler(e);
  });
}

function findTab(tabId) {
  return TABS.find(function(tab) { return tab.id === tabId; }) || null;
}

function hasTab(tabId) {
  return !!findTab(tabId);
}

function ensureTabRecord(tab) {
  var existing = findTab(tab.id);
  if (existing) {
    existing.label = tab.label;
    existing.templateId = tab.templateId || existing.templateId || existing.id;
    existing.baseLabel = tab.baseLabel || existing.baseLabel || existing.label;
    existing.isDefault = !!tab.isDefault;
    return existing;
  }
  var nextTab = {
    id: tab.id,
    label: tab.label,
    templateId: tab.templateId || tab.id,
    baseLabel: tab.baseLabel || tab.label,
    isDefault: !!tab.isDefault
  };
  TABS.push(nextTab);
  return nextTab;
}

function getTabBaseId(tab) {
  return String((tab && (tab.templateId || tab.id || tab.baseLabel || tab.label)) || 'tab')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'tab';
}

function buildTabDraft(source) {
  var baseLabel = (source && (source.baseLabel || source.label)) || 'Tab';
  var templateId = (source && (source.templateId || source.id)) || 'tab';
  var baseId = getTabBaseId(source);
  var id = baseId;
  var label = baseLabel;
  if (hasTab(id) || TABS.some(function(tab) { return tab.label === label; })) {
    var index = 2;
    id = baseId + '-' + index;
    label = baseLabel + ' ' + index;
    while (hasTab(id) || TABS.some(function(tab) { return tab.label === label; })) {
      index++;
      id = baseId + '-' + index;
      label = baseLabel + ' ' + index;
    }
  }
  return { id: id, label: label, templateId: templateId, baseLabel: baseLabel };
}

function requestCreateTab(payload) {
  if (!ws || ws.readyState !== 1) {
    showToast('连接未就绪，暂时不能新建标签页', 'error', 2500);
    return;
  }
  pendingCreatedTabId = payload.id;
  ws.send(JSON.stringify(payload));
}

function requestDeleteTab(tabId) {
  if (!ws || ws.readyState !== 1) {
    showToast('连接未就绪，暂时不能删除标签页', 'error', 2500);
    return;
  }
  ws.send(JSON.stringify({ type: 'delete_tab', tab: tabId }));
}

function requestRenameTab(tabId, label) {
  if (!ws || ws.readyState !== 1) {
    showToast('连接未就绪，暂时不能重命名标签页', 'error', 2500);
    return;
  }
  ws.send(JSON.stringify({ type: 'rename_tab', tab: tabId, label: label }));
}

function promptRenameTab(tabId) {
  var tab = findTab(tabId);
  if (!tab) return;
  lastRenameActionAt = Date.now();
  var nextLabel = window.prompt('重命名标签页', tab.label);
  if (nextLabel === null) return;
  nextLabel = String(nextLabel).trim().replace(/\s+/g, ' ');
  if (!nextLabel || nextLabel === tab.label) return;
  requestRenameTab(tabId, nextLabel);
}

function removeMountedTab(tabId) {
  var index = TABS.findIndex(function(tab) { return tab.id === tabId; });
  if (index !== -1) TABS.splice(index, 1);
  if (terms[tabId] && typeof terms[tabId].dispose === 'function') {
    try { terms[tabId].dispose(); } catch (err) {}
  }
  delete terms[tabId];
  delete fitAddons[tabId];
  if (panels[tabId]) panels[tabId].remove();
  delete panels[tabId];
  var tabEl = headerEl.querySelector('.tab[data-tab="' + tabId + '"]');
  if (tabEl) tabEl.remove();
}

function ensureCloseButton(tabEl, tab) {
  var closeEl = tabEl.querySelector('.tab-close');
  if (tab.isDefault) {
    if (closeEl) closeEl.remove();
    return;
  }
  if (!closeEl) {
    closeEl = document.createElement('button');
    closeEl.type = 'button';
    closeEl.className = 'tab-close';
    closeEl.setAttribute('aria-label', '删除标签页');
    closeEl.textContent = 'x';
    bindPress(closeEl, function() {
      requestDeleteTab(tab.id);
    });
    tabEl.appendChild(closeEl);
  }
}

function positionTabTemplateMenu() {
  var wasHidden = !tabTemplateMenuEl.classList.contains('show');
  if (wasHidden) {
    tabTemplateMenuEl.style.visibility = 'hidden';
    tabTemplateMenuEl.classList.add('show');
  }
  var rect = addTabMenuBtnEl.getBoundingClientRect();
  var menuWidth = Math.max(tabTemplateMenuEl.offsetWidth || 164, isMobile ? 152 : 164);
  var menuHeight = tabTemplateMenuEl.offsetHeight || 0;
  var viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  var viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  var left = Math.min(rect.right - menuWidth, viewportWidth - menuWidth - 8);
  left = Math.max(8, left);
  var top = rect.bottom + 8;
  if (top + menuHeight > viewportHeight - 8) {
    top = Math.max(8, rect.top - menuHeight - 8);
  }
  tabTemplateMenuEl.style.left = left + 'px';
  tabTemplateMenuEl.style.top = top + 'px';
  if (wasHidden) {
    tabTemplateMenuEl.classList.remove('show');
    tabTemplateMenuEl.style.visibility = '';
  }
}

function closeTabTemplateMenu() {
  tabTemplateMenuEl.classList.remove('show');
}

function isTabMenuTarget(target) {
  return !!(target && (
    target.closest('#tab-template-menu')
    || target.closest('#add-tab-menu-btn')
    || target.closest('#add-tab-btn')
  ));
}

function renderTabTemplateMenu() {
  tabTemplateMenuEl.innerHTML = '';
  TAB_TEMPLATES.forEach(function(template) {
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'tab-template-item';
    item.innerHTML = '<span>' + template.label + '</span><small>新建</small>';
    bindPress(item, function() {
      var draft = buildTabDraft(template);
      closeTabTemplateMenu();
      requestCreateTab({
        type: 'create_tab',
        templateId: template.id,
        id: draft.id,
        label: draft.label
      });
    });
    tabTemplateMenuEl.appendChild(item);
  });
}

renderTabTemplateMenu();

bindPress(addTabBtnEl, function() {
  var source = findTab(activeTab) || TABS[0] || TAB_TEMPLATES[0];
  if (!source) return;
  var draft = buildTabDraft(source);
  requestCreateTab({
    type: 'create_tab',
    sourceTabId: source.id,
    id: draft.id,
    label: draft.label
  });
});

bindPress(addTabMenuBtnEl, function() {
  var nextShow = !tabTemplateMenuEl.classList.contains('show');
  if (nextShow) {
    positionTabTemplateMenu();
    tabTemplateMenuEl.classList.add('show');
  } else {
    closeTabTemplateMenu();
  }
});

document.addEventListener('click', function(e) {
  if (!isTabMenuTarget(e.target)) closeTabTemplateMenu();
});
document.addEventListener('touchend', function(e) {
  if (!isTabMenuTarget(e.target)) closeTabTemplateMenu();
});
window.addEventListener('resize', function() {
  if (tabTemplateMenuEl.classList.contains('show')) positionTabTemplateMenu();
});
headerEl.addEventListener('scroll', function() {
  if (tabTemplateMenuEl.classList.contains('show')) positionTabTemplateMenu();
});

function getTermTextarea(term) {
  if (!term) return null;
  if (term.textarea) return term.textarea;
  if (term.element) return term.element.querySelector('.xterm-helper-textarea');
  return null;
}

function getTermViewport(term) {
  if (!term || !term.element) return null;
  return term.element.querySelector('.xterm-viewport');
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

function focusTermTextarea(term) {
  var textarea = getTermTextarea(term);
  if (!textarea) return;
  textarea.readOnly = false;
  textarea.disabled = false;
  textarea.setAttribute('inputmode', 'text');
  textarea.setAttribute('enterkeyhint', 'enter');
  try {
    textarea.focus({ preventScroll: true });
  } catch (err) {
    try { textarea.focus(); } catch (focusErr) {}
  }
  if (typeof textarea.setSelectionRange === 'function') {
    try {
      var value = textarea.value || '';
      textarea.setSelectionRange(value.length, value.length);
    } catch (rangeErr) {}
  }
}

function installMobileTextareaBridge(term, tabId) {
  if (!isMobile) return;
  var textarea = getTermTextarea(term);
  if (!textarea || textarea.dataset.mobileBridgeInstalled === '1') return;
  textarea.dataset.mobileBridgeInstalled = '1';

  var bridgeState = {
    composing: false,
    lastDispatchedText: '',
    lastDispatchAt: 0
  };

  function clearTextareaValue() {
    textarea.value = '';
    if (typeof textarea.setSelectionRange === 'function') {
      try {
        textarea.setSelectionRange(0, 0);
      } catch (rangeErr) {}
    }
  }

  function recentlyDispatched(text) {
    return !!text
      && bridgeState.lastDispatchedText === text
      && (Date.now() - bridgeState.lastDispatchAt) < 120;
  }

  function dispatchTextareaText(text) {
    if (!text) {
      clearTextareaValue();
      return;
    }
    if (recentlyDispatched(text)) {
      clearTextareaValue();
      return;
    }
    bridgeState.lastDispatchedText = text;
    bridgeState.lastDispatchAt = Date.now();
    sendRaw(tabId, text);
    clearTextareaValue();
    requestActiveTermFocus();
  }

  function dispatchControlInput(data) {
    sendRaw(tabId, data);
    clearTextareaValue();
    requestActiveTermFocus();
  }

  textarea.addEventListener('compositionstart', function() {
    bridgeState.composing = true;
  }, true);

  textarea.addEventListener('compositionend', function(e) {
    bridgeState.composing = false;
    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
    dispatchTextareaText((e && e.data) || textarea.value || '');
  }, true);

  textarea.addEventListener('beforeinput', function(e) {
    if (!e) return;
    if (e.inputType === 'insertCompositionText') return;
    if (e.inputType === 'deleteCompositionText') {
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      clearTextareaValue();
      return;
    }
    if (e.inputType === 'deleteContentBackward') {
      e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      dispatchControlInput('\x7f');
      return;
    }
    if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      dispatchControlInput(String.fromCharCode(13));
      return;
    }
    if (e.inputType === 'insertText'
      || e.inputType === 'insertReplacementText'
      || e.inputType === 'insertFromComposition') {
      if (bridgeState.composing && e.inputType !== 'insertFromComposition') return;
      var text = e.data || textarea.value || '';
      if (!text) return;
      e.preventDefault();
      if (typeof e.stopPropagation === 'function') e.stopPropagation();
      dispatchTextareaText(text);
    }
  }, true);
}

function focusTermOnce(term) {
  if (!term) return;
  suppressNativeCaret(term);
  focusTermTextarea(term);
  if (typeof term.focus === 'function') {
    try { term.focus(); } catch (err) {}
  }
  focusTermTextarea(term);
}

var focusRetryTimers = [];

function clearFocusRetryTimers() {
  while (focusRetryTimers.length) {
    clearTimeout(focusRetryTimers.pop());
  }
}

function requestActiveTermFocus() {
  clearFocusRetryTimers();
  var delays = isMobile ? [0, 60, 180, 360] : [0];
  delays.forEach(function(delay) {
    var timer = setTimeout(function() {
      if (!terms[activeTab]) return;
      focusTermOnce(terms[activeTab]);
    }, delay);
    focusRetryTimers.push(timer);
  });
}

function syncActiveTermFocus(shouldFocus) {
  Object.keys(terms).forEach(function(id) {
    if (id !== activeTab) blurTerm(terms[id]);
  });
  suppressNativeCaret(terms[activeTab]);
  if (shouldFocus && terms[activeTab]) focusTermOnce(terms[activeTab]);
}

function mountTab(tab) {
  var t = ensureTabRecord(tab);
  var tabEl = headerEl.querySelector('.tab[data-tab="' + t.id + '"]');
  if (!tabEl) {
    tabEl = document.createElement('div');
    var renamePressTimer = null;
    function clearRenamePressTimer() {
      if (renamePressTimer) {
        clearTimeout(renamePressTimer);
        renamePressTimer = null;
      }
    }
    tabEl.addEventListener('dblclick', function(e) {
      if (e.target.closest('.tab-close')) return;
      e.preventDefault();
      e.stopPropagation();
      promptRenameTab(t.id);
    });
    tabEl.addEventListener('touchstart', function(e) {
      if (e.target.closest('.tab-close')) return;
      clearRenamePressTimer();
      renamePressTimer = setTimeout(function() {
        renamePressTimer = null;
        promptRenameTab(t.id);
      }, 450);
    }, { passive: true });
    tabEl.addEventListener('touchend', clearRenamePressTimer, { passive: true });
    tabEl.addEventListener('touchcancel', clearRenamePressTimer, { passive: true });
    tabEl.addEventListener('touchmove', clearRenamePressTimer, { passive: true });
    tabEl.onclick = function(e) {
      if (e.target.closest('.tab-close')) return;
      if (Date.now() - lastRenameActionAt < 450) return;
      switchTab(t.id);
    };
    headerEl.insertBefore(tabEl, rightEl);
  }
  tabEl.className = 'tab' + (t.id === activeTab ? ' active' : '') + (t.isDefault ? '' : ' closable');
  tabEl.dataset.tab = t.id;
  tabEl.setAttribute('title', t.label);
  var labelEl = tabEl.querySelector('.tab-label');
  if (!labelEl) {
    labelEl = document.createElement('span');
    labelEl.className = 'tab-label';
    tabEl.insertBefore(labelEl, tabEl.firstChild);
  }
  labelEl.textContent = t.label;
  ensureCloseButton(tabEl, t);

  if (panels[t.id] || terms[t.id]) return t;

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
    fontSize: isMobile ? 11 : 14,
    fontFamily: isMobile
      ? "'ui-monospace','SFMono-Regular','SF Mono','Cascadia Code','Menlo','Consolas',monospace,'Symbols Nerd Font Mono'"
      : "'Cascadia Code','Fira Code','JetBrains Mono','Menlo','Consolas','Symbols Nerd Font Mono',monospace",
    lineHeight: isMobile ? 1.05 : 1.15,
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
  installMobileTextareaBridge(term, t.id);
  fit.fit();
  terms[t.id] = term;
  fitAddons[t.id] = fit;
  term.onScroll(function() {
    scheduleScrollBottomButtonUpdate();
  });

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
  return t;
}

TABS.slice().forEach(function(tab) {
  mountTab(tab);
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
  scheduleScrollBottomButtonUpdate();
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
    scheduleScrollBottomButtonUpdate();
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
var scrollBottomButtonRaf = 0;

function updateScrollBottomButton() {
  var term = terms[activeTab];
  var shouldShow = false;
  if (term && term.buffer && term.buffer.active && !overlayEl.classList.contains('show')) {
    shouldShow = (term.buffer.active.baseY - term.buffer.active.viewportY) > 2;
  }
  scrollBottomBtnEl.classList.toggle('show', shouldShow);
}

function scheduleScrollBottomButtonUpdate() {
  if (scrollBottomButtonRaf) return;
  scrollBottomButtonRaf = requestAnimationFrame(function() {
    scrollBottomButtonRaf = 0;
    updateScrollBottomButton();
  });
}

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
    scheduleScrollBottomButtonUpdate();
    var t = terms[activeTab];
    ws.send(JSON.stringify({ type: 'activate', tab: activeTab, cols: t.cols, rows: t.rows }));
  };

  ws.onmessage = function(e) {
    try {
      var msg = JSON.parse(e.data);
      if (msg.type === 'tab_added') {
        mountTab(msg.tab);
        if (pendingCreatedTabId && msg.tab && msg.tab.id === pendingCreatedTabId) {
          pendingCreatedTabId = null;
          switchTab(msg.tab.id);
        } else {
          scheduleScrollBottomButtonUpdate();
        }
      } else if (msg.type === 'tab_renamed') {
        mountTab(msg.tab);
      } else if (msg.type === 'tab_removed') {
        var removedTabId = msg.tab;
        var nextTabId = msg.nextTab || null;
        var wasActive = activeTab === removedTabId;
        removeMountedTab(removedTabId);
        if (pendingCreatedTabId === removedTabId) pendingCreatedTabId = null;
        if (wasActive) {
          activeTab = null;
          if (nextTabId && findTab(nextTabId)) switchTab(nextTabId);
          else if (TABS[0]) {
            activeTab = TABS[0].id;
            document.querySelectorAll('.tab').forEach(function(el) {
              el.classList.toggle('active', el.dataset.tab === activeTab);
            });
            Object.keys(panels).forEach(function(id) {
              panels[id].classList.toggle('active', id === activeTab);
            });
            doFit();
            syncActiveTermFocus(!isMobile);
          }
        }
        scheduleScrollBottomButtonUpdate();
      } else if (msg.type === 'tab_error') {
        if (pendingCreatedTabId && msg.id === pendingCreatedTabId) pendingCreatedTabId = null;
        showToast(msg.message || '新建标签页失败', 'error', 3000);
      } else if (msg.type === 'output' || msg.type === 'scrollback') {
        if (terms[msg.tab]) terms[msg.tab].write(msg.data);
        scheduleScrollBottomButtonUpdate();
      } else if (msg.type === 'clear') {
        if (terms[msg.tab]) terms[msg.tab].clear();
        scheduleScrollBottomButtonUpdate();
      } else if (msg.type === 'yolo') {
        var yoloBtn = document.getElementById('yolo-btn');
        if (yoloBtn) yoloBtn.classList.toggle('on', msg.yolo);
      } else if (msg.type === 'exit') {
        if (terms[msg.tab]) {
          terms[msg.tab].write('\\r\\n\\x1b[31m[Session ended]\\x1b[0m\\r\\n');
        }
        scheduleScrollBottomButtonUpdate();
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
      scheduleScrollBottomButtonUpdate();
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

function sendMobileShortcut(data) {
  sendRaw(activeTab, data);
  requestActiveTermFocus();
}

function scrollActiveTabToBottom() {
  var term = terms[activeTab];
  if (term) term.scrollToBottom();
  scheduleScrollBottomButtonUpdate();
}

scrollBottomBtnEl.addEventListener('click', function() {
  scrollActiveTabToBottom();
  requestActiveTermFocus();
});

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
  var yoloBtnEl = document.getElementById('yolo-btn');
  var ctrlcBtnEl = document.getElementById('btn-ctrlc');
  var statusIndicatorEl = document.getElementById('status-indicator');
  if (yoloBtnEl && ctrlcBtnEl && ctrlcBtnEl.parentNode) {
    ctrlcBtnEl.parentNode.insertBefore(yoloBtnEl, ctrlcBtnEl);
  }
  if (statusIndicatorEl && ctrlcBtnEl && ctrlcBtnEl.parentNode) {
    ctrlcBtnEl.parentNode.appendChild(statusIndicatorEl);
    statusIndicatorEl.classList.add('in-mobile-bar');
  }

  // --- Keyboard handling via visualViewport ---
  if (window.visualViewport) {
    var KEYBOARD_OPEN_THRESHOLD = 120;
    var lastVH = window.visualViewport.height;
    var keyboardOpen = false;
    var viewportBaseHeight = Math.max(
      window.innerHeight,
      window.visualViewport.height + (window.visualViewport.offsetTop || 0)
    );
    function adjustForKeyboard() {
      var viewport = window.visualViewport;
      var vh = viewport.height;
      var offsetTop = viewport.offsetTop || 0;
      var visibleHeight = vh + offsetTop;
      if (!keyboardOpen) {
        viewportBaseHeight = Math.max(viewportBaseHeight, window.innerHeight, visibleHeight);
      }
      var obscuredBottom = Math.max(0, viewportBaseHeight - visibleHeight);
      var nextKeyboardOpen = obscuredBottom > KEYBOARD_OPEN_THRESHOLD;
      if (nextKeyboardOpen) {
        appEl.style.height = visibleHeight + 'px';
      } else {
        appEl.style.removeProperty('height');
        viewportBaseHeight = Math.max(window.innerHeight, visibleHeight);
      }
      // Scroll terminal to bottom when keyboard opens
      if (nextKeyboardOpen && (!keyboardOpen || vh < lastVH - 24)) {
        setTimeout(scrollActiveTabToBottom, 50);
        setTimeout(requestActiveTermFocus, 80);
      }
      keyboardOpen = nextKeyboardOpen;
      lastVH = vh;
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(doFit, 80);
    }
    window.visualViewport.addEventListener('resize', adjustForKeyboard);
    window.visualViewport.addEventListener('scroll', function() { window.scrollTo(0, 0); });
    adjustForKeyboard();
  }

  // --- Touch: scroll terminal + swipe to switch tabs ---
  var touchStartY = 0, lastTouchY = 0, touchDir = null;
  var termWrap = document.getElementById('terminal-wrap');
  var SCROLL_PIXELS_PER_PIXEL = 1.2;

  termWrap.addEventListener('touchstart', function(e) {
    if (e.touches.length !== 1) return;
    touchStartY = e.touches[0].clientY;
    lastTouchY = touchStartY;
    touchDir = null;
  }, { passive: true });

  termWrap.addEventListener('touchmove', function(e) {
    if (e.touches.length !== 1) return;
    var curY = e.touches[0].clientY;
    var dy = curY - touchStartY;

    if (!touchDir) {
      if (Math.abs(dy) > 4) touchDir = 'v';
      else return;
    }

    if (touchDir === 'v') {
      var term = terms[activeTab];
      if (!term) return;
      var delta = lastTouchY - curY;
      if (Math.abs(delta) >= 1) {
        var viewport = getTermViewport(term);
        if (viewport) {
          viewport.scrollTop += delta * SCROLL_PIXELS_PER_PIXEL;
        } else {
          term.scrollLines(Math.round(delta / 12));
        }
        lastTouchY = curY;
        scheduleScrollBottomButtonUpdate();
      }
      e.preventDefault();
    }
  }, { passive: false });

  // --- Ctrl+C button ---
  document.getElementById('btn-ctrlc').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut(String.fromCharCode(3));
  }, { passive: false });

  // --- Enter button ---
  document.getElementById('btn-enter').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut(String.fromCharCode(13));
  }, { passive: false });

  // --- Backspace button ---
  document.getElementById('btn-backspace').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut('\x7f');
  }, { passive: false });

  // --- Shift+Enter button: send newline ---
  document.getElementById('btn-newline').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut('\\n');
  }, { passive: false });

  // --- Tab button ---
  document.getElementById('btn-tab').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut(String.fromCharCode(9));
  }, { passive: false });

  // --- Esc button ---
  document.getElementById('btn-esc').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut('\x1b');
  }, { passive: false });

  // --- Shift+Tab button ---
  document.getElementById('btn-shift-tab').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut('\x1b[Z');
  }, { passive: false });

  // --- Delete button ---
  document.getElementById('btn-del').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut('\x1b[3~');
  }, { passive: false });

  // --- Paste button: read clipboard and send to terminal ---
  document.getElementById('btn-paste').addEventListener('click', function(e) {
    e.preventDefault();
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function(text) {
        if (text) {
          sendRaw(activeTab, text);
          requestActiveTermFocus();
        }
      }).catch(function() {});
    }
  });

  // --- Arrow buttons ---
  document.getElementById('btn-up').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut('\x1b[A');
  }, { passive: false });
  document.getElementById('btn-down').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut('\x1b[B');
  }, { passive: false });
  document.getElementById('btn-right').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut('\x1b[C');
  }, { passive: false });
  document.getElementById('btn-left').addEventListener('touchstart', function(e) {
    e.preventDefault();
    sendMobileShortcut('\x1b[D');
  }, { passive: false });

  // --- Tap terminal to focus xterm (show keyboard) ---
  function focusTerminalFromTap(e) {
    if (touchDir === 'v') return; // was scrolling
    if (e.target.closest('#mobile-bar') || e.target.closest('#overlay')) return;
    requestActiveTermFocus();
  }
  termWrap.addEventListener('touchend', focusTerminalFromTap);
  termWrap.addEventListener('click', focusTerminalFromTap);
}

// Desktop focus
if (!isMobile) {
  syncActiveTermFocus(true);
  document.addEventListener('click', function(e) {
    if (!e.target.closest('button') && !e.target.closest('.tab') && !e.target.closest('input') && !e.target.closest('textarea')) {
      requestActiveTermFocus();
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
function uploadBlob(fileLike, fallbackName) {
  var payload = fileLike && fileLike.blob ? fileLike.blob : fileLike;
  var fileName = (fileLike && fileLike.name) || fallbackName || ('upload-' + Date.now());
  var fileSize = (fileLike && typeof fileLike.size === 'number') ? fileLike.size : ((payload && payload.size) || 0);
  if (fileSize > MAX_UPLOAD_MB * 1024 * 1024) {
    var sizeMB = (fileSize / 1024 / 1024).toFixed(1);
    return Promise.reject(new Error(fileName + ' 太大（' + sizeMB + 'MB），最大 ' + MAX_UPLOAD_MB + 'MB'));
  }
  return new Promise(function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    var encodedName = encodeURIComponent(fileName);
    xhr.open('POST', '/upload?name=' + encodedName);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) {
        var pct = Math.round(e.loaded / e.total * 100);
        showToast(fileName + ' ' + pct + '%', 'info', 30000);
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
    xhr.send(payload);
  });
}

function uploadFile(file) {
  return uploadBlob(file, file && file.name);
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
      requestActiveTermFocus();
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
function openUploadPicker() {
  fileInput.click();
}
Array.from(document.querySelectorAll('.upload-trigger')).forEach(function(btn) {
  btn.addEventListener('click', openUploadPicker);
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

  if (url.pathname === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
    res.end(JSON.stringify({
      name: 'CC Terminal',
      short_name: 'CC',
      start_url: '/terminal',
      display: 'standalone',
      background_color: '#1a1a2e',
      theme_color: '#1a1a2e',
    }));
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
        const tab = getTab(tabId);
        if (!tab) return;
        const state = ensureTabState(tabId);
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

      if (msg.type === 'create_tab') {
        const source = msg.sourceTabId ? getTab(msg.sourceTabId) : null;
        const template = msg.templateId ? getTabTemplate(msg.templateId) : null;
        const result = registerRuntimeTabFromSource(source || template, {
          id: msg.id,
          label: msg.label,
        });
        if (result.error) {
          ws.send(JSON.stringify({
            type: 'tab_error',
            id: sanitizeTabId(msg.id),
            message: result.error,
          }));
        } else {
          broadcast({ type: 'tab_added', tab: serializeTab(result.tab) });
        }
      }

      if (msg.type === 'delete_tab') {
        const tabId = sanitizeTabId(msg.tab);
        const index = TABS.findIndex(tab => tab.id === tabId);
        const fallbackTab = TABS.slice(index + 1).find(tab => DEFAULT_TAB_IDS.has(tab.id))
          || TABS.slice(0, index).reverse().find(tab => DEFAULT_TAB_IDS.has(tab.id))
          || TABS.find(tab => tab.id !== tabId)
          || null;
        const result = removeRuntimeTab(tabId);
        if (result.error) {
          ws.send(JSON.stringify({
            type: 'tab_error',
            id: tabId,
            message: result.error,
          }));
        } else {
          broadcast({
            type: 'tab_removed',
            tab: tabId,
            nextTab: fallbackTab ? fallbackTab.id : null,
          });
        }
      }

      if (msg.type === 'rename_tab') {
        const tabId = sanitizeTabId(msg.tab);
        const result = renameTab(tabId, msg.label);
        if (result.error) {
          ws.send(JSON.stringify({
            type: 'tab_error',
            id: tabId,
            message: result.error,
          }));
        } else {
          broadcast({ type: 'tab_renamed', tab: serializeTab(result.tab) });
        }
      }

      if (msg.type === 'restart') {
        const tabId = msg.tab;
        const tab = getTab(tabId);
        const state = ensureTabState(tabId);
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
          persistRuntimeTabs();
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
        if (!getTab(msg.tab)) return;
        const state = ensureTabState(msg.tab);
        if (state && state.pty) state.pty.write(msg.data);
      }

      if (msg.type === 'resize') {
        if (!getTab(msg.tab)) return;
        const state = ensureTabState(msg.tab);
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

