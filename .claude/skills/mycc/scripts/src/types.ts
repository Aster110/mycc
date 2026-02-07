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

/** 图片数据（简化版，完整定义在 image-utils.ts） */
export interface ImageData {
  data: string; // base64 编码（不含 data:image/xxx;base64, 前缀）
  mediaType: string; // MIME 类型
}

/** Chat 请求参数 */
export interface ChatParams {
  message: string;
  sessionId?: string;
  cwd: string;
  images?: ImageData[];
  model?: string;
}


/** JSONL 行结构 */
export interface RawHistoryLine {
  type: "user" | "assistant" | "system" | "result" | "summary" | "custom-title";
  message?: {
    role?: string;
    content?: unknown;
    id?: string;
  };
  summary?: string;  // summary 类型消息的摘要文本
  leafUuid?: string;  // summary 消息：最后一条被压缩的消息 UUID
  customTitle?: string;  // custom-title 类型：用户自定义标题
  sessionId?: string;
  timestamp?: string;
  uuid?: string;
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
  customTitle?: string | null;  // 用户自定义标题（null = 未改名）
  firstPrompt?: string;          // 第一条消息（用于预览）
  modified?: string;             // 修改时间（ISO 字符串）
}

/** 对话详情 */
export interface ConversationHistory {
  sessionId: string;
  messages: RawHistoryLine[];
}

