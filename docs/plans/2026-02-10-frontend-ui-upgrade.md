# Frontend UI Upgrade Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 mycc 前端从简陋的单文件 HTML 升级为基于 claude-code-webui 的 React + Vite + Tailwind 现代化 UI，支持多用户 JWT 认证、丰富的消息渲染（工具调用展示、代码高亮、Markdown 渲染）、流式对话。

**Architecture:**
- 前端：React 19 + Vite + Tailwind CSS，复用 claude-code-webui 的组件架构
- 后端：保持现有 Node.js http.Server + JWT 认证，SSE 流式输出
- 关键改造：前端流式解析从 NDJSON 改为 SSE，添加登录/注册页面，所有 API 调用添加 JWT 认证

**Tech Stack:**
- React 19.1 + React Router 7
- Vite 7 + Tailwind CSS 4
- TypeScript 5.8
- 后端保持不变（Node.js + JWT + PostgreSQL）

---

## Phase 1: 环境准备

### Task 1.1: 创建前端项目结构

**Files:**
- Create: `mycc-web-react/` (新目录)
- Copy from: `/tmp/claude-code-webui/frontend/` → `mycc-web-react/`

**Step 1: 复制 claude-code-webui 前端代码**

```bash
cp -r /tmp/claude-code-webui/frontend/* /Users/armysheng/workspace/mycc/mycc-web-react/
```

**Step 2: 清理不需要的文件**

```bash
cd /Users/armysheng/workspace/mycc/mycc-web-react
rm -rf tests/ playwright.config.ts scripts/record-demo.ts scripts/capture-screenshots.ts
```

**Step 3: 安装依赖**

```bash
cd /Users/armysheng/workspace/mycc/mycc-web-react
npm install
```

Expected: 依赖安装成功，无错误

**Step 4: 验证开发服务器启动**

```bash
npm run dev
```

Expected: Vite 开发服务器启动在 http://localhost:5173

**Step 5: Commit**

```bash
git add mycc-web-react/
git commit -m "feat: 初始化 React 前端项目（基于 claude-code-webui）"
```

---

## Phase 2: 添加认证功能

### Task 2.1: 创建认证上下文和 API

**Files:**
- Create: `mycc-web-react/src/contexts/AuthContext.tsx`
- Create: `mycc-web-react/src/api/auth.ts`
- Create: `mycc-web-react/src/types/auth.ts`

**Step 1: 创建认证类型定义**

File: `mycc-web-react/src/types/auth.ts`

```typescript
export interface User {
  id: number;
  phone?: string;
  email?: string;
  nickname?: string;
  linux_user: string;
  plan: 'free' | 'basic' | 'pro';
}

export interface LoginRequest {
  credential: string;
  password: string;
}

export interface RegisterRequest {
  phone?: string;
  email?: string;
  password: string;
  nickname?: string;
}

export interface AuthResponse {
  code: number;
  data?: {
    token: string;
    user: User;
  };
  message?: string;
}
```

**Step 2: 创建认证 API 函数**

File: `mycc-web-react/src/api/auth.ts`

```typescript
import type { LoginRequest, RegisterRequest, AuthResponse, User } from '../types/auth';

const API_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:8080';

export async function login(data: LoginRequest): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function register(data: RegisterRequest): Promise<AuthResponse> {
  const res = await fetch(`${API_BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return res.json();
}

export async function getCurrentUser(token: string): Promise<{ code: number; data?: User; message?: string }> {
  const res = await fetch(`${API_BASE}/api/auth/me`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  return res.json();
}
```

**Step 3: 创建认证上下文**

File: `mycc-web-react/src/contexts/AuthContext.tsx`

```typescript
import { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import type { User } from '../types/auth';
import { getCurrentUser } from '../api/auth';

interface AuthContextType {
  user: User | null;
  token: string | null;
  login: (token: string, user: User) => void;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('token'));
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    if (token) {
      getCurrentUser(token)
        .then(res => {
          if (res.code === 0 && res.data) {
            setUser(res.data);
          } else {
            localStorage.removeItem('token');
            setToken(null);
          }
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, [token]);

  const login = (newToken: string, newUser: User) => {
    localStorage.setItem('token', newToken);
    setToken(newToken);
    setUser(newUser);
  };

  const logout = () => {
    localStorage.removeItem('token');
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
```

**Step 4: Commit**

```bash
git add mycc-web-react/src/contexts/AuthContext.tsx mycc-web-react/src/api/auth.ts mycc-web-react/src/types/auth.ts
git commit -m "feat: 添加认证上下文和 API"
```

---

### Task 2.2: 创建登录/注册页面

**Files:**
- Create: `mycc-web-react/src/components/LoginPage.tsx`

**Step 1: 创建登录/注册页面组件**

File: `mycc-web-react/src/components/LoginPage.tsx`

```typescript
import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { login as apiLogin, register as apiRegister } from '../api/auth';

export function LoginPage() {
  const { login } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [credential, setCredential] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiLogin({ credential, password });
      if (res.code === 0 && res.data) {
        login(res.data.token, res.data.user);
      } else {
        setError(res.message || '登录失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const res = await apiRegister({ phone, email, password, nickname });
      if (res.code === 0 && res.data) {
        login(res.data.token, res.data.user);
      } else {
        setError(res.message || '注册失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '注册失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl p-8 w-full max-w-md">
        <h1 className="text-3xl font-bold text-center mb-6 text-slate-800 dark:text-white">
          MyCC
        </h1>

        <div className="flex gap-2 mb-6">
          <button
            onClick={() => setMode('login')}
            className={`flex-1 py-2 rounded ${mode === 'login' ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-700'}`}
          >
            登录
          </button>
          <button
            onClick={() => setMode('register')}
            className={`flex-1 py-2 rounded ${mode === 'register' ? 'bg-blue-600 text-white' : 'bg-slate-200 dark:bg-slate-700'}`}
          >
            注册
          </button>
        </div>

        {error && (
          <div className="mb-4 p-3 bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300 rounded">
            {error}
          </div>
        )}

        {mode === 'login' ? (
          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="text"
              placeholder="手机号/邮箱"
              value={credential}
              onChange={(e) => setCredential(e.target.value)}
              className="w-full p-3 border rounded dark:bg-slate-700 dark:border-slate-600"
              required
            />
            <input
              type="password"
              placeholder="密码"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-3 border rounded dark:bg-slate-700 dark:border-slate-600"
              required
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? '登录中...' : '登录'}
            </button>
          </form>
        ) : (
          <form onSubmit={handleRegister} className="space-y-4">
            <input
              type="tel"
              placeholder="手机号"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="w-full p-3 border rounded dark:bg-slate-700 dark:border-slate-600"
            />
            <input
              type="email"
              placeholder="邮箱（可选）"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full p-3 border rounded dark:bg-slate-700 dark:border-slate-600"
            />
            <input
              type="text"
              placeholder="昵称"
              value={nickname}
              onChange={(e) => setNickname(e.target.value)}
              className="w-full p-3 border rounded dark:bg-slate-700 dark:border-slate-600"
            />
            <input
              type="password"
              placeholder="密码（至少6位）"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full p-3 border rounded dark:bg-slate-700 dark:border-slate-600"
              required
              minLength={6}
            />
            <button
              type="submit"
              disabled={loading}
              className="w-full py-3 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? '注册中...' : '注册'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add mycc-web-react/src/components/LoginPage.tsx
git commit -m "feat: 添加登录/注册页面"
```

---

## Phase 3: 修改流式解析（NDJSON → SSE）

### Task 3.1: 修改流式解析 Hook

**Files:**
- Modify: `mycc-web-react/src/hooks/streaming/useStreamParser.ts`

**Step 1: 读取原有代码**

```bash
cat mycc-web-react/src/hooks/streaming/useStreamParser.ts
```

**Step 2: 修改解析逻辑从 NDJSON 改为 SSE**

找到 NDJSON 解析逻辑（按行分割 JSON），改为 SSE 格式解析（`data: {...}\n\n`）。

原代码可能类似：
```typescript
const lines = chunk.split('\n').filter(line => line.trim());
for (const line of lines) {
  const data = JSON.parse(line);
  // ...
}
```

改为：
```typescript
const lines = chunk.split('\n');
for (const line of lines) {
  if (line.startsWith('data: ')) {
    const jsonStr = line.slice(6); // 去掉 "data: "
    if (jsonStr.trim()) {
      const data = JSON.parse(jsonStr);
      // ...
    }
  }
}
```

**Step 3: 测试解析逻辑**

创建测试文件验证 SSE 解析：

```typescript
// 测试代码
const testSSE = `data: {"type":"claude_json","data":{"type":"assistant"}}\n\ndata: {"type":"done"}\n\n`;
// 验证能正确解析
```

**Step 4: Commit**

```bash
git add mycc-web-react/src/hooks/streaming/useStreamParser.ts
git commit -m "fix: 修改流式解析从 NDJSON 改为 SSE 格式"
```

---

## Phase 4: 添加 JWT 认证到 API 调用

### Task 4.1: 修改 Chat API 添加认证

**Files:**
- Modify: `mycc-web-react/src/hooks/useClaudeStreaming.ts`
- Modify: `mycc-web-react/src/config/api.ts`

**Step 1: 修改 API 配置添加认证 header**

File: `mycc-web-react/src/config/api.ts`

添加辅助函数：
```typescript
export const getAuthHeaders = (token: string | null) => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
};
```

**Step 2: 修改 useClaudeStreaming Hook 添加 token 参数**

在 `useClaudeStreaming.ts` 中：
- 添加 `token` 参数
- 在 fetch 调用中使用 `getAuthHeaders(token)`

**Step 3: Commit**

```bash
git add mycc-web-react/src/hooks/useClaudeStreaming.ts mycc-web-react/src/config/api.ts
git commit -m "feat: Chat API 添加 JWT 认证"
```

---

## Phase 5: 集成路由和主应用

### Task 5.1: 修改 App.tsx 添加认证路由

**Files:**
- Modify: `mycc-web-react/src/App.tsx`
- Modify: `mycc-web-react/src/main.tsx`

**Step 1: 修改 main.tsx 添加 AuthProvider**

```typescript
import { AuthProvider } from './contexts/AuthContext';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </React.StrictMode>,
);
```

**Step 2: 修改 App.tsx 添加路由守卫**

```typescript
import { useAuth } from './contexts/AuthContext';
import { LoginPage } from './components/LoginPage';
import { ChatPage } from './components/ChatPage';

function App() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return <div className="min-h-screen flex items-center justify-center">加载中...</div>;
  }

  if (!user) {
    return <LoginPage />;
  }

  return <ChatPage />;
}
```

**Step 3: Commit**

```bash
git add mycc-web-react/src/App.tsx mycc-web-react/src/main.tsx
git commit -m "feat: 添加认证路由守卫"
```

---

## Phase 6: 后端集成

### Task 6.1: 修改后端 serve 新前端

**Files:**
- Modify: `.claude/skills/mycc/scripts/src/http-server.ts:183-195`

**Step 1: 构建前端生产版本**

```bash
cd mycc-web-react
npm run build
```

Expected: 生成 `dist/` 目录

**Step 2: 修改后端 serve 路径**

File: `.claude/skills/mycc/scripts/src/http-server.ts`

修改 `handleIndex` 方法：
```typescript
private handleIndex(res: http.ServerResponse) {
  try {
    // 从 scripts/src/ 到 mycc-web-react/dist/
    const indexPath = join(import.meta.dirname, '..', '..', '..', '..', '..', 'mycc-web-react', 'dist', 'index.html');
    const html = readFileSync(indexPath, 'utf-8');
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Frontend not found");
  }
}
```

同时添加静态资源 serve：
```typescript
// 在 handleRequest 中添加
if (url.pathname.startsWith('/assets/')) {
  this.handleStatic(req, res, url.pathname);
  return;
}

private handleStatic(req: http.IncomingMessage, res: http.ServerResponse, pathname: string) {
  try {
    const staticPath = join(import.meta.dirname, '..', '..', '..', '..', '..', 'mycc-web-react', 'dist', pathname);
    const content = readFileSync(staticPath);
    const ext = pathname.split('.').pop();
    const contentType = {
      'js': 'application/javascript',
      'css': 'text/css',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'svg': 'image/svg+xml',
    }[ext || ''] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
}
```

**Step 3: 重启服务器测试**

```bash
# 杀掉旧进程
lsof -i :8080 -t | xargs kill

# 启动新服务器
.claude/skills/mycc/scripts/node_modules/.bin/tsx .claude/skills/mycc/scripts/src/index.ts start --multi-user
```

**Step 4: 浏览器测试**

访问 http://localhost:8080，验证：
- 登录页面正常显示
- 注册功能正常
- 登录后进入对话页面
- 对话功能正常（流式输出、工具调用展示）

**Step 5: Commit**

```bash
git add .claude/skills/mycc/scripts/src/http-server.ts mycc-web-react/dist/
git commit -m "feat: 后端集成新前端构建产物"
```

---

## Phase 7: 测试和优化

### Task 7.1: 端到端测试

**测试清单：**

1. **认证流程**
   - [ ] 注册新用户
   - [ ] 登录已有用户
   - [ ] Token 过期后自动登出
   - [ ] 刷新页面保持登录状态

2. **对话功能**
   - [ ] 发送消息并接收流式响应
   - [ ] 工具调用（Bash）正确展示
   - [ ] 代码块语法高亮
   - [ ] Markdown 渲染正确
   - [ ] Thinking 消息折叠展示

3. **多用户隔离**
   - [ ] 不同用户看到不同的会话历史
   - [ ] 不同用户的 cwd 隔离

4. **性能**
   - [ ] 首屏加载时间 < 2s
   - [ ] 流式响应延迟 < 500ms

**Step 1: 执行测试清单**

逐项测试并记录结果。

**Step 2: 修复发现的问题**

根据测试结果修复 bug。

**Step 3: Commit**

```bash
git add .
git commit -m "test: 完成端到端测试并修复问题"
```

---

## 完成标准

- [x] 前端项目结构创建完成
- [x] 认证功能实现（登录/注册/JWT）
- [x] 流式解析从 NDJSON 改为 SSE
- [x] 所有 API 调用添加 JWT 认证
- [x] 路由守卫和主应用集成
- [x] 后端 serve 新前端
- [x] 端到端测试通过
- [x] 代码已提交到 git

---

## 注意事项

1. **保持后端不变**：后端 API 格式和路由保持不变，只修改前端
2. **渐进式迁移**：先保证基本功能（登录+对话）可用，再优化细节
3. **复用组件**：最大化复用 claude-code-webui 的组件，减少重复开发
4. **测试驱动**：每个 Phase 完成后立即测试，避免积累问题
