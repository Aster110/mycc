/**
 * Web 通道
 *
 * 包装现有的 SSE 逻辑，将消息发送到 Web 客户端
 */

import type { MessageChannel } from "./interface.js";
import type { SSEEvent } from "../adapters/interface.js";
import type { ServerResponse } from "http";

/**
 * Web 通道配置
 */
export interface WebChannelConfig {
  /** HTTP 响应对象 */
  res: ServerResponse;
}

/**
 * Web 消息通道
 *
 * 包装 SSE 响应，将消息发送到 Web 客户端
 */
export class WebChannel implements MessageChannel {
  readonly id = "web";

  private res: ServerResponse;
  private sessionId?: string;

  constructor(config: WebChannelConfig) {
    this.res = config.res;
  }

  /**
   * 设置当前会话 ID
   * @param sessionId - 会话 ID
   */
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /**
   * 获取当前会话 ID
   */
  getSessionId(): string | undefined {
    return this.sessionId;
  }

  /**
   * 不需要过滤器 - Web 通道接收所有消息
   */
  // filter 方法未定义，表示接受所有消息

  /**
   * 发送消息到 Web 客户端（SSE）
   * @param event - SSE 事件
   */
  async send(event: SSEEvent): Promise<void> {
    // 提取 session_id（如果有）
    if (event && typeof event === "object" && "type" in event) {
      if (event.type === "system" && "session_id" in event) {
        this.sessionId = event.session_id as string;
      }
    }

    // 发送 SSE 数据
    const data = JSON.stringify(event);
    this.res.write(`data: ${data}\n\n`);
  }

  /**
   * 发送完成信号
   */
  async sendDone(): Promise<void> {
    const doneEvent = { type: "done", sessionId: this.sessionId };
    await this.send(doneEvent);
    this.res.end();
  }

  /**
   * 发送错误信号
   * @param error - 错误信息
   */
  async sendError(error: string): Promise<void> {
    const errorEvent = { type: "error", error };
    await this.send(errorEvent);
    this.res.end();
  }
}
