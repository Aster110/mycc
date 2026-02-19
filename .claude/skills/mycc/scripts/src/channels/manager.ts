/**
 * 通道管理器
 *
 * 管理多个消息通道，支持广播消息到所有通道
 */

import type { MessageChannel } from "./interface.js";
import type { SSEEvent } from "../adapters/interface.js";

/**
 * 可启动的通道接口
 */
export interface StartableChannel {
  start?(): Promise<void> | void;
  stop?(): void;
}

/**
 * 通道管理器
 *
 * 负责注册通道和广播消息
 */
export class ChannelManager {
  /** 已注册的通道 */
  private channels = new Map<string, MessageChannel>();

  /**
   * 注册通道
   * @param channel - 要注册的通道
   */
  register(channel: MessageChannel): void {
    this.channels.set(channel.id, channel);
  }

  /**
   * 注销通道
   * @param channelId - 通道 ID
   */
  unregister(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) {
      // 如果通道支持停止，先停止
      if ("stop" in channel && typeof channel.stop === "function") {
        (channel as StartableChannel).stop?.();
      }
      this.channels.delete(channelId);
    }
  }

  /**
   * 启动所有已注册的通道
   * 任意通道启动失败不影响其他通道
   */
  async startAll(): Promise<void> {
    const results: Array<{ channelId: string; success: boolean; error?: string }> = [];

    for (const channel of this.channels.values()) {
      if ("start" in channel && typeof channel.start === "function") {
        try {
          await (channel as StartableChannel).start?.();
          results.push({ channelId: channel.id, success: true });
        } catch (error: any) {
          results.push({
            channelId: channel.id,
            success: false,
            error: error instanceof Error ? error.message : String(error)
          });
          // 不抛出异常，继续启动其他通道
        }
      }
    }

    // 打印启动结果
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    console.log(`[ChannelManager] 已启动 ${successCount}/${this.channels.size} 个通道`);

    if (failCount > 0) {
      console.warn(`[ChannelManager] 以下通道启动失败：`);
      for (const result of results) {
        if (!result.success) {
          console.warn(`  - ${result.channelId}: ${result.error}`);
        }
      }
    }
  }

  /**
   * 停止所有已注册的通道
   */
  stopAll(): void {
    for (const channel of this.channels.values()) {
      if ("stop" in channel && typeof channel.stop === "function") {
        (channel as StartableChannel).stop?.();
      }
    }
    console.log("[ChannelManager] All channels stopped");
  }

  /**
   * 广播消息到所有通道
   * 每个通道的 filter 方法会被调用，只有返回 true 的通道才会收到消息
   * @param event - 要广播的 SSE 事件
   */
  async broadcast(event: SSEEvent): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const channel of this.channels.values()) {
      // 检查过滤器
      if (channel.filter && !channel.filter(event)) {
        continue; // 跳过被过滤的消息
      }

      // 发送消息
      promises.push(channel.send(event));
    }

    // 等待所有通道发送完成
    await Promise.all(promises);
  }

  /**
   * 获取已注册的通道数量
   */
  get size(): number {
    return this.channels.size;
  }

  /**
   * 检查通道是否已注册
   * @param channelId - 通道 ID
   */
  has(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /**
   * 获取所有已注册的通道 ID
   */
  getChannelIds(): string[] {
    return Array.from(this.channels.keys());
  }
}
