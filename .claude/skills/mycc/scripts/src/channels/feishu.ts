/**
 * 飞书通道
 *
 * 支持双向通信：
 * - 发送：将 Claude Code 回复发送到飞书
 * - 接收：通过 WebSocket 接收飞书消息并转发给 Claude Code
 */

import type { MessageChannel } from "./interface.js";
import type { SSEEvent } from "../adapters/interface.js";
import Lark from "@larksuiteoapi/node-sdk";

/**
 * 飞书通道配置
 */
export interface FeishuChannelConfig {
  /** 飞书应用 ID */
  appId: string;
  /** 飞书应用密钥 */
  appSecret: string;
  /** 接收消息的用户/群组 Open ID */
  receiveUserId?: string;
  /** 接收 ID 类型：open_id（用户）或 chat_id（群聊） */
  receiveIdType?: "open_id" | "chat_id";
  /** 连接模式：websocket（长连接）或 poll（轮询） */
  connectionMode?: "websocket" | "poll";
  /** Encrypt Key（用于验证事件推送） */
  encryptKey?: string;
  /** Verification Token（用于验证事件推送） */
  verificationToken?: string;
  /** 是否显示工具调用：true（显示）或 false（不显示），默认 true */
  showToolUse?: boolean;
}

/**
 * 图片上传响应
 */
interface FeishuUploadResponse {
  code: number;
  msg: string;
  data: {
    image_key: string;
  };
}

/**
 * 飞书消息通道
 *
 * 实现消息过滤、发送和接收功能
 * 支持双向通信：发送 Claude 回复到飞书，接收飞书消息并转发给 Claude
 */
export class FeishuChannel implements MessageChannel {
  readonly id = "feishu";

  private config: FeishuChannelConfig;
  private accessToken: string | null = null;
  private tokenExpireTime: number = 0;
  private pendingImages = new Map<string, string>(); // sessionId → image_key

  // WebSocket 相关
  private wsClient: Lark.WSClient | null = null;
  private eventDispatcher: Lark.EventDispatcher | null = null;
  private messageCallback: ((message: string, messageId?: string) => void) | null = null;

  // 表态相关（"正在输入" emoji）
  private currentMessageId: string | null = null;
  private currentReactionId: string | null = null;

  constructor(config?: FeishuChannelConfig) {
    // 从环境变量读取配置
    this.config = config || {
      appId: process.env.FEISHU_APP_ID || "",
      appSecret: process.env.FEISHU_APP_SECRET || "",
      receiveUserId: process.env.FEISHU_RECEIVE_USER_ID,
      receiveIdType: (process.env.FEISHU_RECEIVE_ID_TYPE as "open_id" | "chat_id") || "open_id",
      connectionMode: (process.env.FEISHU_CONNECTION_MODE as "websocket" | "poll") || "poll",
      encryptKey: process.env.FEISHU_ENCRYPT_KEY,
      verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
      showToolUse: process.env.FEISHU_SHOW_TOOL_USE === "false" ? false : true, // 默认 true
    };
  }

  /**
   * 消息过滤器 - 支持 v1 和 v2 SDK 的事件类型
   * v1: text, content_block_delta, system, tool_use
   * v2: assistant (包含消息内容), system
   */
  filter(event: SSEEvent): boolean {
    const eventType = event.type as string;
    // 调试：记录所有事件类型（包括被过滤的）
    console.log(`[FeishuChannel] [FILTER] 收到事件类型: ${eventType}`);

    const textOnlyTypes = ["text", "content_block_delta", "system", "assistant"];
    const allTypes = ["text", "content_block_delta", "system", "assistant", "tool_use"];

    // 根据配置决定是否显示工具调用
    if (this.config.showToolUse) {
      return allTypes.includes(eventType);
    } else {
      return textOnlyTypes.includes(eventType);
    }
  }

  /**
   * 发送消息到飞书
   * @param event - SSE 事件
   */
  async send(event: SSEEvent): Promise<void> {
    // 调试：记录所有事件类型
    if (event.type) {
      console.log(`[FeishuChannel] [DEBUG] 收到事件: ${event.type}${event.type === "assistant" ? " (检查 tool_use)" : ""}`);
    }

    // 如果没有配置飞书凭证，静默跳过
    if (!this.config.appId || !this.config.appSecret) {
      return;
    }

    // 没有配置接收用户，跳过
    if (!this.config.receiveUserId) {
      return;
    }

    // 处理 system 事件（提取图片信息）
    if (event.type === "system") {
      const systemEvent = event as Record<string, unknown>;
      // 检查是否有图片数据
      if ("images" in systemEvent && Array.isArray(systemEvent.images)) {
        const sessionId = String(systemEvent.session_id || "default");
        await this.handleImages(sessionId, systemEvent.images as Array<{ data: string; mediaType: string }>);
      }
      return;
    }

    // 处理 tool_use 事件（工具调用）
    if (event.type === "tool_use") {
      if (!this.config.showToolUse) {
        return;
      }
      const toolEvent = event as Record<string, unknown>;
      const toolContent = this.formatToolUse(toolEvent);
      if (toolContent) {
        const sessionId = this.extractSessionId(event);
        await this.sendMessageToFeishu(toolContent, sessionId);
      }
      return;
    }

    // 处理 v2 SDK 的 assistant 事件（包含消息内容）
    if (event.type === "assistant") {
      const assistantEvent = event as Record<string, unknown>;
      console.log(`[FeishuChannel] [DEBUG] assistant 事件完整结构:`, JSON.stringify(assistantEvent).substring(0, 500));

      // 提取消息内容
      let content = "";
      let toolCalls: string[] = [];

      if ("message" in assistantEvent && typeof assistantEvent.message === "object") {
        const message = assistantEvent.message as Record<string, unknown>;
        if ("content" in message && Array.isArray(message.content)) {
          console.log(`[FeishuChannel] [DEBUG] assistant.content 有 ${message.content.length} 个 block`);
          // content 是一个数组，包含多个 block
          for (const block of message.content) {
            if (typeof block === "object" && block !== null) {
              const blockType = (block as any).type;
              console.log(`[FeishuChannel] [DEBUG] block type: ${blockType}`, JSON.stringify(block).substring(0, 200));
              if ("type" in block && block.type === "text" && "text" in block) {
                // 纯文本内容
                content += String(block.text);
              } else if ("type" in block && block.type === "tool_use" && this.config.showToolUse) {
                // 工具调用，格式化显示
                console.log(`[FeishuChannel] [DEBUG] 找到 tool_use block，showToolUse=${this.config.showToolUse}`);
                const toolCall = this.formatToolUseBlock(block as Record<string, unknown>);
                if (toolCall) {
                  toolCalls.push(toolCall);
                }
              }
            }
          }
        } else {
          console.log(`[FeishuChannel] [DEBUG] assistant.message 没有 content 数组，有字段:`, Object.keys(message));
        }
      } else {
        console.log(`[FeishuChannel] [DEBUG] assistant 事件没有 message 字段，有字段:`, Object.keys(assistantEvent));
      }

      const sessionId = this.extractSessionId(event);

      // 先发送文本内容
      if (content) {
        await this.sendMessageToFeishu(content, sessionId);
      }

      // 再发送工具调用（每条单独发送）
      console.log(`[FeishuChannel] [DEBUG] 准备发送 ${toolCalls.length} 个工具调用`);
      for (const toolCall of toolCalls) {
        console.log(`[FeishuChannel] [DEBUG] 发送工具调用内容: ${toolCall.substring(0, 100)}...`);
        await this.sendMessageToFeishu(toolCall, sessionId);
        console.log(`[FeishuChannel] [DEBUG] 工具调用发送完成`);
      }

      return;
    }

    // 提取文本内容和 session_id
    const text = this.extractText(event);
    const sessionId = this.extractSessionId(event);

    if (!text) {
      return;
    }

    // 发送消息到飞书（先发送图片，再发送文字）
    await this.sendMessageToFeishu(text, sessionId);
  }

  /**
   * 设置消息接收回调
   * @param callback - 收到飞书消息时的回调函数
   */
  onMessage(callback: (message: string) => void): void {
    this.messageCallback = callback;
  }

  /**
   * 启动飞书通道（验证凭证 + 启动 WebSocket）
   */
  async start(): Promise<void> {
    if (!this.config.appId || !this.config.appSecret) {
      console.log("[FeishuChannel] Not configured, skipping");
      return;
    }

    // 验证凭证
    const token = await this.getAccessToken();
    if (!token) {
      console.error("[FeishuChannel] ✗ Invalid credentials");
      return;
    }

    console.log("[FeishuChannel] ✓ Credentials validated");
    console.log(`[FeishuChannel] Will send to: ${this.config.receiveUserId || "未配置接收用户"}`);

    // 启动 WebSocket 连接（如果配置了）
    if (this.config.connectionMode === "websocket") {
      await this.startWebSocket();
    } else {
      console.log("[FeishuChannel] WebSocket disabled (polling mode)");
    }
  }

  /**
   * 启动 WebSocket 连接
   */
  private async startWebSocket(): Promise<void> {
    try {
      // 创建 Event Dispatcher（只在配置了加密密钥时传入）
      const dispatcherOptions: {
        encryptKey?: string;
        verificationToken?: string;
      } = {};
      if (this.config.encryptKey) {
        dispatcherOptions.encryptKey = this.config.encryptKey;
      }
      if (this.config.verificationToken) {
        dispatcherOptions.verificationToken = this.config.verificationToken;
      }

      this.eventDispatcher = new Lark.EventDispatcher(dispatcherOptions);

      // 注册多个事件类型（参考 monitor.ts）
      this.eventDispatcher.register({
        // 消息接收事件
        "im.message.receive_v1": async (data) => {
          try {
            console.log("[FeishuChannel] [DEBUG] 收到 im.message.receive_v1 事件");
            const event = data as any;
            const messageId = event?.message?.message_id;

            // 添加"正在输入"表态（敲键盘 emoji）
            if (messageId) {
              this.addTypingIndicator(messageId).catch(() => {
                // 静默失败，不影响主流程
              });
            }

            const content = this.parseFeishuMessage(event);
            if (content && this.messageCallback) {
              console.log(`[FeishuChannel] ✓ 收到消息: ${content.substring(0, 50)}...`);
              // 传递消息 ID，以便后续可以删除表态
              this.messageCallback(content, messageId);
            } else if (!content) {
              console.log("[FeishuChannel] [DEBUG] 解析消息内容为空");
            }
          } catch (err) {
            console.error("[FeishuChannel] 消息处理错误:", err);
          }
        },
        // 消息已读事件（忽略）
        "im.message.message_read_v1": async () => {
          console.log("[FeishuChannel] [DEBUG] 收到 im.message.message_read_v1 事件（忽略）");
        },
        // 机器人被添加到群聊事件
        "im.chat.member.bot.added_v1": async (data) => {
          try {
            const event = data as any;
            console.log(`[FeishuChannel] ✓ 机器人被添加到群聊: ${event?.chat_id || "unknown"}`);
          } catch (err) {
            console.error("[FeishuChannel] 处理机器人添加事件错误:", err);
          }
        },
        // 机器人被移出群聊事件
        "im.chat.member.bot.deleted_v1": async (data) => {
          try {
            const event = data as any;
            console.log(`[FeishuChannel] ✓ 机器人被移出群聊: ${event?.chat_id || "unknown"}`);
          } catch (err) {
            console.error("[FeishuChannel] 处理机器人移除事件错误:", err);
          }
        },
      });

      // 创建 WebSocket 客户端
      this.wsClient = new Lark.WSClient({
        appId: this.config.appId,
        appSecret: this.config.appSecret,
        domain: Lark.Domain.Feishu,
        loggerLevel: Lark.LoggerLevel.info,
      });

      // 启动连接
      this.wsClient.start({ eventDispatcher: this.eventDispatcher });
      console.log("[FeishuChannel] ✓ WebSocket 已启动");
      console.log("[FeishuChannel] [INFO] 已注册事件: im.message.receive_v1, im.message.message_read_v1, im.chat.member.bot.added_v1, im.chat.member.bot.deleted_v1");
    } catch (err) {
      console.error("[FeishuChannel] ✗ WebSocket 启动失败:", err);
    }
  }

  /**
   * 解析飞书消息
   */
  private parseFeishuMessage(event: any): string | null {
    try {
      // 事件结构: event.sender + event.message（不是 event.event.message）
      if (!event?.message) return null;

      const message = event.message;
      const messageType = message.message_type;
      const content = message.content;

      if (messageType === "text") {
        // 文本消息 - content 是 JSON 字符串
        if (typeof content === "string") {
          const parsed = JSON.parse(content);
          return parsed.text || "";
        }
        // 兜底：content 可能已经是对象
        return content?.text || "";
      }

      // 其他类型消息暂不支持
      console.log(`[FeishuChannel] 暂不支持的消息类型: ${messageType}`);
      return null;
    } catch (err) {
      console.error("[FeishuChannel] 解析消息失败:", err);
      return null;
    }
  }

  /**
   * 停止飞书通道
   */
  stop() {
    this.accessToken = null;
    this.pendingImages.clear();

    // 停止 WebSocket
    if (this.wsClient) {
      try {
        this.wsClient.stop();
        console.log("[FeishuChannel] WebSocket 已停止");
      } catch {
        // 静默处理
      }
      this.wsClient = null;
    }
    this.eventDispatcher = null;
    this.messageCallback = null;
  }

  /**
   * 从 SSE 事件中提取文本内容
   */
  private extractText(event: SSEEvent): string {
    if (event.type === "text") {
      return String(event.text ?? "");
    }

    if (event.type === "content_block_delta") {
      const delta = event.delta as { text?: string } | undefined;
      return delta?.text ?? "";
    }

    return "";
  }

  /**
   * 从 SSE 事件中提取 session_id
   */
  private extractSessionId(event: SSEEvent): string | undefined {
    if (event && typeof event === "object" && "session_id" in event) {
      return String(event.session_id);
    }
    return undefined;
  }

  /**
   * 格式化 tool_use 事件为可读文本
   */
  private formatToolUse(event: Record<string, unknown>): string {
    try {
      const name = event.name as string || "unknown";
      const input = event.input as Record<string, unknown> || {};

      let output = `🔧 使用工具: **${name}**\n`;

      // 格式化输入参数
      if (Object.keys(input).length > 0) {
        output += "```\n";
        output += JSON.stringify(input, null, 2);
        output += "\n```\n";
      }

      return output;
    } catch (err) {
      console.error("[FeishuChannel] 格式化工具调用失败:", err);
      return "🔧 使用工具（详情解析失败）";
    }
  }

  /**
   * 格式化 assistant 事件中的 tool_use block
   */
  private formatToolUseBlock(block: Record<string, unknown>): string | null {
    try {
      const name = block.name as string || "unknown";
      const input = block.input as Record<string, unknown> || {};

      let output = `🔧 **${name}**`;

      // 如果有输入参数，简要显示
      if (Object.keys(input).length > 0) {
        const inputStr = JSON.stringify(input);
        if (inputStr.length > 100) {
          output += ` ${inputStr.substring(0, 100)}...`;
        } else {
          output += ` ${inputStr}`;
        }
      }

      return output;
    } catch (err) {
      console.error("[FeishuChannel] 格式化工具调用失败:", err);
      return "🔧 工具调用（详情解析失败）";
    }
  }

  /**
   * 处理图片（上传到飞书并保存 image_key）
   */
  private async handleImages(sessionId: string, images: Array<{ data: string; mediaType: string }>): Promise<void> {
    if (!images || images.length === 0) {
      return;
    }

    // 只支持单张图片
    const image = images[0];

    try {
      // 上传图片到飞书
      const imageKey = await this.uploadImageToFeishu(image.data, image.mediaType);
      if (imageKey) {
        // 保存 image_key
        this.pendingImages.set(sessionId, imageKey);
        console.log(`[FeishuChannel] ✓ Image uploaded: ${imageKey}`);
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Upload image error:", error);
    }
  }

  /**
   * 上传图片到飞书
   */
  private async uploadImageToFeishu(base64Data: string, mediaType: string): Promise<string | null> {
    try {
      // 获取访问令牌（如果需要）
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return null;
        }
      }

      // 将 base64 转换为 Buffer
      const buffer = Buffer.from(base64Data, "base64");

      // 上传图片
      const response = await fetch("https://open.feishu.cn/open-apis/im/v1/images", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": mediaType,
        },
        body: buffer,
      });

      const result = await response.json() as FeishuUploadResponse;
      if (result.code === 0 && result.data?.image_key) {
        return result.data.image_key;
      }

      console.error("[FeishuChannel] ✗ Upload failed:", result.msg);
      return null;
    } catch (error) {
      console.error("[FeishuChannel] ✗ Upload error:", error);
      return null;
    }
  }

  /**
   * 发送消息到飞书
   */
  private async sendMessageToFeishu(text: string, sessionId?: string): Promise<boolean> {
    try {
      // 获取访问令牌（如果需要）
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return false;
        }
      }

      const userId = this.config.receiveUserId!;

      // 如果有待发送的图片，先发送图片
      if (sessionId && this.pendingImages.has(sessionId)) {
        const imageKey = this.pendingImages.get(sessionId)!;
        const imageSent = await this.sendImageMessage(userId, imageKey);
        if (imageSent) {
          // 图片发送成功后，移除记录
          this.pendingImages.delete(sessionId);
          // 等待一下，避免消息顺序混乱
          await sleep(500);
        }
      }

      // 发送文本消息（使用飞书富文本格式，支持 Markdown）
      const receiveIdType = this.config.receiveIdType || "open_id";

      // 构建飞书富文本格式（post 类型），支持 Markdown
      const postContent = {
        zh_cn: {
          content: [
            [
              {
                tag: "md",
                text: text,
              },
            ],
          ],
        },
      };

      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: userId,
          msg_type: "post",
          content: JSON.stringify(postContent),
        }),
      });

      const result = await response.json();
      if (result.code === 0) {
        console.log(`[FeishuChannel] ✓ Sent: ${text.substring(0, 30)}${text.length > 30 ? "..." : ""}`);
        return true;
      } else {
        console.error("[FeishuChannel] ✗ Send failed:", result.msg);
        return false;
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Send error:", error);
      return false;
    }
  }

  /**
   * 发送图片消息到飞书
   */
  private async sendImageMessage(userId: string, imageKey: string): Promise<boolean> {
    try {
      const receiveIdType = this.config.receiveIdType || "open_id";
      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          receive_id: userId,
          msg_type: "image",
          content: JSON.stringify({ image_key: imageKey }),
        }),
      });

      const result = await response.json();
      if (result.code === 0) {
        console.log(`[FeishuChannel] ✓ Image sent: ${imageKey}`);
        return true;
      } else {
        console.error("[FeishuChannel] ✗ Image send failed:", result.msg);
        return false;
      }
    } catch (error) {
      console.error("[FeishuChannel] ✗ Image send error:", error);
      return false;
    }
  }

  /**
   * 获取飞书访问令牌
   */
  private async getAccessToken(): Promise<string | null> {
    try {
      const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: this.config.appId,
          app_secret: this.config.appSecret,
        }),
      });

      const data = await response.json();
      if (data.code === 0) {
        // 提前 5 分钟刷新令牌
        this.tokenExpireTime = Date.now() + (data.expire - 300) * 1000;
        return data.tenant_access_token;
      }

      console.error("[FeishuChannel] Get token failed:", data);
      return null;
    } catch (error) {
      console.error("[FeishuChannel] Get token error:", error);
      return null;
    }
  }

  /**
   * 添加"正在输入"表态（敲键盘 emoji）
   * 参照 C:\Users\wannago\.openclaw\extensions\feishu\src\typing.ts
   * @returns reactionId - 表态 ID，用于后续删除
   */
  private async addTypingIndicator(messageId: string): Promise<string | null> {
    try {
      // 获取访问令牌
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return null;
        }
      }

      // 使用飞书 API 添加表态（reaction）
      // emoji_type: "Typing" 是飞书内置的"正在输入"表情
      const response = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reaction_type: {
            emoji_type: "Typing",
          },
        }),
      });

      const result = await response.json();
      if (result.code === 0 && result.data?.reaction_id) {
        // 保存 messageId 和 reactionId
        this.currentMessageId = messageId;
        this.currentReactionId = result.data.reaction_id;
        console.log(`[FeishuChannel] ✓ 已添加正在输入表态 (${this.currentReactionId})`);
        return this.currentReactionId;
      }
      // 静默失败 - 表态不是关键功能
      return null;
    } catch (error) {
      // 静默失败 - 表态不是关键功能
      console.log(`[FeishuChannel] 添加表态失败（非关键）: ${error}`);
      return null;
    }
  }

  /**
   * 移除表态（可选功能）
   */
  private async removeTypingIndicator(messageId: string, reactionId: string): Promise<void> {
    try {
      if (!this.accessToken || Date.now() > this.tokenExpireTime) {
        this.accessToken = await this.getAccessToken();
        if (!this.accessToken) {
          return;
        }
      }

      await fetch(`https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/reactions/${reactionId}`, {
        method: "DELETE",
        headers: {
          "Authorization": `Bearer ${this.accessToken}`,
        },
      });
    } catch (error) {
      // 静默失败 - 清理不是关键功能
    }
  }

  /**
   * 移除当前的"正在输入"表态（公共方法）
   */
  async clearTypingIndicator(): Promise<void> {
    if (this.currentMessageId && this.currentReactionId) {
      await this.removeTypingIndicator(this.currentMessageId, this.currentReactionId);
      this.currentMessageId = null;
      this.currentReactionId = null;
      console.log("[FeishuChannel] ✓ 已移除正在输入表态");
    }
  }
}

/** sleep 辅助函数 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
