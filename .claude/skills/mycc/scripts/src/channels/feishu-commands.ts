/**
 * 飞书命令处理模块
 *
 * 从 HttpServer 提取的飞书消息处理和命令系统
 */

import type { CCAdapter } from "../adapters/interface.js";
import type { ChannelManager } from "./manager.js";
import type { DeviceConfig } from "../types.js";
import type { FeishuStreamingSession } from "./feishu-streaming.js";

export interface FeishuCommandsDeps {
  adapter: CCAdapter;
  channelManager: ChannelManager;
  cwd: string;
  feishuChannel: any;
  loadConfig: (cwd: string) => DeviceConfig | null;
}

export class FeishuCommands {
  private deps: FeishuCommandsDeps;
  private _currentSessionId: string | null = null;

  constructor(deps: FeishuCommandsDeps) {
    this.deps = deps;
  }

  get currentSessionId(): string | null {
    return this._currentSessionId;
  }

  set currentSessionId(id: string | null) {
    this._currentSessionId = id;
  }

  /**
   * 处理飞书收到的消息
   * @param message - 消息文本
   * @param images - 图片数组
   * @param messageId - 原始消息 ID，用于回复和流式卡片
   */
  async processMessage(message: string, images?: Array<{ data: string; mediaType: string }>, messageId?: string): Promise<void> {
    console.log(`[CC] 收到飞书消息: ${message.substring(0, 50)}...${images ? ` [${images.length} 张图片]` : ""}`);

    const trimmedMessage = message.trim();

    // 检查是否是命令
    if (trimmedMessage.startsWith("/")) {
      await this.handleFeishuCommand(trimmedMessage);
      return;
    }

    // 普通对话：检查是否有活跃会话
    if (!this._currentSessionId) {
      console.log(`[CC] 无活跃会话，尝试自动选择最近的历史会话`);

      try {
        const result = await this.deps.adapter.listHistory(this.deps.cwd, 1);
        if (result.conversations.length > 0) {
          const latestSession = result.conversations[0];
          this._currentSessionId = latestSession.sessionId;

          const title = latestSession.customTitle || latestSession.firstPrompt?.substring(0, 30) || "历史会话";
          const timeAgo = this.formatTimeAgo(latestSession.lastTime || latestSession.modified || Date.now());

          console.log(`[CC] 自动选择会话: ${this._currentSessionId} (${title})`);
          await this.sendToFeishu(`已自动使用最近的会话：${title}\n${timeAgo}\n\n继续你的对话...`);
        } else {
          console.log(`[CC] 没有历史会话，显示帮助信息`);
          await this.sendToFeishu("还没有会话记录。\n\n发送任意消息开始新对话\n发送 /help 查看所有命令");
          return;
        }
      } catch (err) {
        console.error(`[CC] 获取历史会话失败:`, err);
        await this.sendToFeishu("无法加载历史会话，请重试或发送 /new 创建新会话。");
        return;
      }
    }

    console.log(`[CC] 使用当前会话: ${this._currentSessionId}`);

    // 尝试启动流式卡片（单卡片实时更新，替代逐条消息）
    let streamingSession: FeishuStreamingSession | null = null;
    const feishuChannel = this.deps.feishuChannel;

    if (feishuChannel && messageId) {
      try {
        const cfg = feishuChannel.getConfig();
        if (cfg.appId && cfg.appSecret && cfg.receiveUserId) {
          const session = feishuChannel.createStreamingSession();
          const idType = cfg.receiveIdType === "chat_id" ? "chat_id" : "open_id";
          await session.start(cfg.receiveUserId, idType, messageId);
          streamingSession = session;
          console.log(`[CC] 流式卡片已启动`);
        }
      } catch (err) {
        console.warn(`[CC] 流式卡片启动失败，降级为普通消息: ${err}`);
        streamingSession = null;
      }
    }

    let accumulatedText = "";

    try {
      for await (const data of this.deps.adapter.chat({
        message: trimmedMessage,
        sessionId: this._currentSessionId,
        cwd: this.deps.cwd,
        images: images,
      })) {
        if (data && typeof data === "object") {
          if (data.type === "system" && "session_id" in data) {
            this._currentSessionId = data.session_id as string;
            console.log(`[CC] 会话已更新: ${this._currentSessionId}`);
          }

          if (streamingSession) {
            // 流式卡片模式：收集文本并实时更新
            if (data.type === "text" && data.text) {
              accumulatedText += String(data.text);
              await streamingSession.update(accumulatedText);
            } else if (data.type === "assistant") {
              const content = (data as any).message?.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "text" && block.text) {
                    accumulatedText += String(block.text);
                  }
                }
                await streamingSession.update(accumulatedText);
              }
            }
          } else {
            // 降级模式：逐条发送
            if (data.type === "text" && data.text) {
              const text = String(data.text);
              console.log(`[CC] 发送文本: ${text.substring(0, 30)}...`);
              await this.sendToFeishu(text);
            } else if (data.type === "assistant") {
              const assistantEvent = data as any;
              if (assistantEvent.message?.content) {
                for (const block of assistantEvent.message.content) {
                  if (block.type === "text" && block.text) {
                    const text = String(block.text);
                    console.log(`[CC] 发送文本: ${text.substring(0, 30)}...`);
                    await this.sendToFeishu(text);
                  } else if (block.type === "tool_use") {
                    const name = block.name || "unknown";
                    let toolCallText = `**使用工具: ${name}**`;
                    if (block.input && Object.keys(block.input).length > 0) {
                      const inputStr = JSON.stringify(block.input, null, 2);
                      toolCallText +=
                        inputStr.length > 300
                          ? `\n\`\`\`\n${inputStr.substring(0, 300)}...\n\`\`\``
                          : `\n\`\`\`\n${inputStr}\n\`\`\``;
                    }
                    console.log(`[CC] 发送工具调用: ${name}`);
                    await this.sendToFeishu(toolCallText);
                  }
                }
              }
            }
          }
        }
      }

      // 关闭流式卡片
      if (streamingSession) {
        await streamingSession.close(accumulatedText || undefined);
      }
    } catch (err) {
      console.error(`[CC] 处理飞书消息错误:`, err);
      if (streamingSession) {
        await streamingSession
          .close(accumulatedText || "处理消息时出错，请重试。")
          .catch(() => {});
      } else {
        await this.sendToFeishu("处理消息时出错，请重试。");
      }
    } finally {
      if (feishuChannel) {
        await feishuChannel.clearTypingIndicator();
      }
    }
  }

  /**
   * 处理飞书命令
   */
  private async handleFeishuCommand(command: string): Promise<void> {
    const parts = command.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const args = parts.slice(1);

    console.log(`[CC] 处理飞书命令: ${cmd}`);

    try {
      switch (cmd) {
        case "/new":
        case "/create":
          await this.handleNewSession(args.join(" "));
          break;

        case "/sessions":
        case "/list":
        case "/history":
          await this.handleListSessions();
          break;

        case "/switch":
          await this.handleSwitchSession(args[0]);
          break;

        case "/current":
          await this.handleCurrentSession();
          break;

        case "/device":
        case "/devices":
          await this.handleDevice();
          break;

        case "/help":
        case "/?":
          await this.handleHelp();
          break;

        default:
          await this.sendToFeishu(`未知命令: ${cmd}\n\n发送 /help 查看可用命令。`);
      }
    } catch (err) {
      console.error(`[CC] 命令处理错误:`, err);
      await this.sendToFeishu(`执行命令时出错: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async handleNewSession(title?: string): Promise<void> {
    console.log(`[CC] 创建新会话${title ? `: ${title}` : ''}`);

    try {
      const replyParts: string[] = [];
      let newSessionId: string | undefined;

      for await (const data of this.deps.adapter.chat({
        message: title || "开始新对话",
        cwd: this.deps.cwd,
      })) {
        if (data && typeof data === "object") {
          if (data.type === "system" && "session_id" in data) {
            this._currentSessionId = data.session_id as string;
            newSessionId = data.session_id as string;
            console.log(`[CC] 新会话已创建: ${this._currentSessionId}`);
          }
          if (data.type === "text" && data.text) {
            replyParts.push(String(data.text));
          } else if (data.type === "assistant") {
            const assistantEvent = data as any;
            if (assistantEvent.message?.content) {
              for (const block of assistantEvent.message.content) {
                if (block.type === "text" && block.text) {
                  replyParts.push(String(block.text));
                }
              }
            }
          }
        }
      }

      let response = "";
      if (newSessionId) {
        response = `新会话已创建\n\n`;
        response += `会话 ID: ${newSessionId}\n`;
        if (title) {
          response += `标题: ${title}\n`;
        }
        response += `\n`;
      }

      if (replyParts.length > 0) {
        response += replyParts.join("").trim();
      } else if (newSessionId) {
        response += `现在发送的消息将使用此会话。`;
      }

      await this.sendToFeishu(response);
    } catch (err) {
      console.error(`[CC] 创建会话错误:`, err);
      await this.sendToFeishu("创建会话失败，请重试。");
    }
  }

  private async handleListSessions(): Promise<void> {
    console.log(`[CC] 列出历史会话`);

    try {
      const result = await this.deps.adapter.listHistory(this.deps.cwd, 10);
      const conversations = result.conversations;

      if (conversations.length === 0) {
        await this.sendToFeishu("还没有历史会话。\n\n发送 /new 创建第一个会话。");
        return;
      }

      let output = `历史会话 (共 ${result.total} 个，显示最近 ${conversations.length} 个)\n\n`;

      conversations.forEach((conv, index) => {
        const isCurrent = conv.sessionId === this._currentSessionId ? " [当前]" : "";

        let title = "未命名会话";
        if (conv.customTitle) {
          title = conv.customTitle;
        } else if (conv.firstPrompt) {
          title = conv.firstPrompt.substring(0, 30);
        } else if (conv.lastMessagePreview) {
          title = conv.lastMessagePreview.substring(0, 30);
        }

        const timeAgo = this.formatTimeAgo(conv.lastTime || conv.modified || Date.now());
        output += `${index + 1}. ${title}${isCurrent}\n`;
        output += `   ${timeAgo}\n\n`;
      });

      output += `使用 /switch <序号> 切换到某个会话`;

      await this.sendToFeishu(output);
    } catch (err) {
      console.error(`[CC] 获取会话列表错误:`, err);
      await this.sendToFeishu("获取会话列表失败，请重试。");
    }
  }

  private async handleSwitchSession(target: string | undefined): Promise<void> {
    console.log(`[CC] 切换会话: ${target}`);

    if (!target) {
      await this.sendToFeishu("请指定要切换的会话序号。\n\n使用 /sessions 查看所有会话。");
      return;
    }

    try {
      const result = await this.deps.adapter.listHistory(this.deps.cwd, 50);
      const conversations = result.conversations;

      const index = parseInt(target, 10) - 1;
      if (isNaN(index) || index < 0 || index >= conversations.length) {
        await this.sendToFeishu(`无效的序号: ${target}\n\n使用 /sessions 查看有效序号。`);
        return;
      }

      const targetSession = conversations[index];

      if (targetSession.sessionId === this._currentSessionId) {
        const title = targetSession.customTitle || targetSession.firstPrompt?.substring(0, 30) || "未命名";
        await this.sendToFeishu(`已经在这个会话中了：${title}`);
        return;
      }

      this._currentSessionId = targetSession.sessionId;
      const title = targetSession.customTitle || targetSession.firstPrompt?.substring(0, 30) || "未命名";
      const timeAgo = this.formatTimeAgo(targetSession.lastTime || targetSession.modified || Date.now());

      await this.sendToFeishu(
        `已切换到会话：${title}\n\n` +
        `最后更新: ${timeAgo}\n\n` +
        `现在发送的消息将使用这个会话。`
      );
    } catch (err) {
      console.error(`[CC] 切换会话错误:`, err);
      await this.sendToFeishu("切换会话失败，请重试。");
    }
  }

  private async handleCurrentSession(): Promise<void> {
    console.log(`[CC] 显示当前会话`);

    if (!this._currentSessionId) {
      await this.sendToFeishu("当前没有活跃的会话。\n\n使用 /new 创建会话，或 /sessions 选择一个历史会话。");
      return;
    }

    try {
      const conversation = await this.deps.adapter.getHistory(this.deps.cwd, this._currentSessionId);

      if (!conversation) {
        await this.sendToFeishu("当前会话不存在。\n\n使用 /new 创建新会话。");
        return;
      }

      let title = "未命名会话";
      let lastMessageTime: string | undefined;

      for (const msg of conversation.messages) {
        if (msg.type === "custom-title" && msg.customTitle) {
          title = msg.customTitle;
        }
        if (msg.timestamp) {
          lastMessageTime = msg.timestamp;
        }
      }

      if (title === "未命名会话") {
        const firstUserMsg = conversation.messages.find(m => m.type === "user" && m.message);
        if (firstUserMsg?.message?.content) {
          const content = firstUserMsg.message.content;
          if (typeof content === "string") {
            title = content.substring(0, 30);
          } else if (Array.isArray(content)) {
            const textBlock = (content as any[]).find((b: any) => b.type === "text" && b.text);
            if (textBlock) {
              title = textBlock.text.substring(0, 30);
            }
          }
        }
      }

      const timeStr = lastMessageTime ? this.formatTimeAgo(lastMessageTime) : "未知";
      const msgCount = conversation.messages.length;

      await this.sendToFeishu(
        `当前会话信息\n\n` +
        `标题: ${title}\n` +
        `ID: ${conversation.sessionId}\n` +
        `消息数: ${msgCount}\n` +
        `最后活动: ${timeStr}`
      );
    } catch (err) {
      console.error(`[CC] 获取会话信息错误:`, err);
      await this.sendToFeishu("获取会话信息失败，请重试。");
    }
  }

  private async handleDevice(): Promise<void> {
    console.log("[CC] 查询设备信息");

    try {
      const config = this.deps.loadConfig(this.deps.cwd) as DeviceConfig;

      if (!config) {
        await this.sendToFeishu("未找到设备配置");
        return;
      }

      const createdAt = new Date(config.createdAt);
      const createdTimeStr = createdAt.toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      let output = "当前设备信息\n\n";
      output += `设备 ID: ${config.deviceId}\n`;
      output += `配对码: ${config.pairCode}\n`;

      if (config.routeToken) {
        output += `连接码: ${config.routeToken}\n`;
      }

      if (config.authToken) {
        output += `状态: 已配对\n`;
      } else {
        output += `状态: 未配对\n`;
      }

      output += `\n创建时间: ${createdTimeStr}`;

      await this.sendToFeishu(output);
    } catch (err) {
      console.error(`[CC] 获取设备信息错误:`, err);
      await this.sendToFeishu("获取设备信息失败，请重试。");
    }
  }

  private async handleHelp(): Promise<void> {
    const helpText =
      "飞书命令帮助\n\n" +
      "**会话管理**\n" +
      "/new [标题] - 创建新会话\n" +
      "/sessions - 查看历史会话\n" +
      "/switch <序号> - 切换到某个会话\n" +
      "/current - 显示当前会话信息\n\n" +
      "**设备管理**\n" +
      "/device - 查看当前设备信息\n\n" +
      "**其他**\n" +
      "/help - 显示此帮助信息\n\n" +
      "**示例**\n" +
      "/new 分析代码\n" +
      "/sessions\n" +
      "/switch 1\n" +
      "/device\n\n" +
      "提示：非命令消息会发送到当前活跃会话";

    await this.sendToFeishu(helpText);
  }

  private async sendToFeishu(text: string): Promise<void> {
    await this.deps.channelManager.broadcast({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
      },
    } as any);
  }

  /**
   * 格式化时间显示
   */
  formatTimeAgo(timestamp: string | number): string {
    const now = Date.now();
    const time = typeof timestamp === "string" ? new Date(timestamp).getTime() : timestamp;
    const diff = now - time;

    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return "刚刚";
    if (minutes < 60) return `${minutes}分钟前`;
    if (hours < 24) return `${hours}小时前`;
    if (days < 7) return `${days}天前`;

    const date = new Date(time);
    return `${date.getMonth() + 1}/${date.getDate()}`;
  }
}
