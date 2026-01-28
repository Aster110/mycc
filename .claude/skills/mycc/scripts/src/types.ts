/**
 * 公共类型定义
 */

// ============ 设备与配置 ============

/** 设备配置（持久化到 current.json） */
export interface DeviceConfig {
  deviceId: string;
  pairCode: string;
  routeToken?: string;
  authToken?: string;  // 配对后的认证 token
  createdAt: string;
}

/** Worker 注册结果 */
export interface RegisterResult {
  token: string;
  isNewDevice: boolean;
}

/** 配对状态（运行时） */
export interface PairState {
  pairCode: string;
  paired: boolean;
  token: string | null;
}

// ============ 对话与历史 ============

/** 图片数据（从 image-utils 重新导出，保持兼容） */
export { type ImageData } from "./image-utils.js";

/** Chat 请求参数 */
export interface ChatParams {
  message: string;
  sessionId?: string;
  cwd: string;
  images?: import("./image-utils.js").ImageData[];
}

/** Chat 回调选项 */
export interface ChatCallbacks {
  onMessage: (msg: unknown) => void;
  onDone: (sessionId: string) => void;
  onError: (error: string) => void;
}

/** Chat 完整选项（参数 + 回调） */
export interface ChatOptions extends ChatParams, ChatCallbacks {}

/** JSONL 行结构 */
export interface RawHistoryLine {
  type: "user" | "assistant" | "system" | "result";
  message?: {
    role?: string;
    content?: unknown;
    id?: string;
  };
  sessionId: string;
  timestamp: string;
  uuid: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  cwd?: string;
}

/** 对话摘要 */
export interface ConversationSummary {
  sessionId: string;
  startTime: string;
  lastTime: string;
  messageCount: number;
  lastMessagePreview: string;
}

/** 对话详情 */
export interface ConversationHistory {
  sessionId: string;
  messages: RawHistoryLine[];
}

// ============ WebSocket 消息（旧版，保留兼容） ============

// 本地后端 → 中转服务器
export interface RegisterMessage {
  type: "register";
  deviceId: string;
  pairCode: string;
}

// 小程序 → 中转服务器
export interface PairMessage {
  type: "pair";
  deviceId: string;
  pairCode: string;
}

// 小程序 → 本地后端（经由中转）
export interface ChatMessage {
  type: "chat";
  requestId: string;
  message: string;
  sessionId?: string; // CC 会话 ID
}

// 本地后端 → 小程序（经由中转）
export interface ChatResponse {
  type: "chat_response";
  requestId: string;
  data: unknown; // SDK Message
}

export interface ChatDone {
  type: "chat_done";
  requestId: string;
  sessionId: string; // 返回 CC 会话 ID 供下次续接
}

export interface ChatError {
  type: "chat_error";
  requestId: string;
  error: string;
}

// 中转服务器 → 客户端
export interface PairSuccess {
  type: "pair_success";
  deviceId: string;
}

export interface DeviceOffline {
  type: "device_offline";
}

// 心跳
export interface Ping {
  type: "ping";
}

export interface Pong {
  type: "pong";
}

export type ClientMessage =
  | RegisterMessage
  | PairMessage
  | ChatMessage
  | Ping;

export type ServerMessage =
  | ChatResponse
  | ChatDone
  | ChatError
  | PairSuccess
  | DeviceOffline
  | Pong;
