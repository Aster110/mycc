/**
 * 通道抽象接口
 *
 * 定义消息通道的基本契约，支持多通道并行广播
 */

import type { SSEEvent } from "../adapters/interface.js";

/**
 * 消息通道接口
 *
 * 每个通道代表一个消息输出目标：
 * - WebChannel: SSE 推送到网页/小程序
 * - FeishuChannel: 发送到飞书
 * - 未来可扩展：钉钉、企微等
 */
export interface MessageChannel {
  /**
   * 通道唯一标识符
   */
  id: string;

  /**
   * 发送消息到通道
   * @param event - SSE 事件
   */
  send(event: SSEEvent): Promise<void>;

  /**
   * 可选的消息过滤器
   * @param event - 待过滤的 SSE 事件
   * @returns true 表示发送，false 表示跳过
   *
   * 如果没有提供 filter 方法，默认发送所有消息
   */
  filter?(event: SSEEvent): boolean;
}
