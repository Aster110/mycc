/**
 * Claude CLI stream-json 输出解析器
 * 解析 NDJSON 格式的流式输出，转换为 SSEEvent
 */

export interface SSEEvent {
  type: string;
  [key: string]: any;
}

/**
 * 解析 Claude CLI 的 stream-json 输出
 * @param line NDJSON 格式的单行 JSON
 * @returns SSEEvent 或 null（如果解析失败）
 */
export function parseStreamLine(line: string): SSEEvent | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const event = JSON.parse(trimmed);
    return event as SSEEvent;
  } catch (err) {
    console.error('解析 stream-json 失败:', trimmed, err);
    return null;
  }
}

/**
 * 从事件流中提取 session_id
 */
export function extractSessionId(event: SSEEvent): string | null {
  if (event.type === 'system' && 'session_id' in event) {
    return event.session_id as string;
  }
  return null;
}

/**
 * 从事件流中提取 usage 信息
 */
export function extractUsage(event: SSEEvent): {
  inputTokens: number;
  outputTokens: number;
} | null {
  if (event.type === 'usage' && 'usage' in event) {
    const usage = event.usage as any;
    return {
      inputTokens: usage.input_tokens || 0,
      outputTokens: usage.output_tokens || 0,
    };
  }
  return null;
}

/**
 * 从事件流中提取 model 信息
 */
export function extractModel(event: SSEEvent): string | null {
  if (event.type === 'system' && 'model' in event) {
    return event.model as string;
  }
  return null;
}
