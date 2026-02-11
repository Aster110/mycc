/**
 * 多用户 Adapter
 * 基于原 mycc 的 OfficialAdapter，添加用户隔离
 */

import { query, type SDKUserMessage } from '@anthropic-ai/claude-code';
import { detectClaudeCliPath } from './platform.js';

export interface ChatParams {
  message: string;
  sessionId?: string;
  cwd: string;
  images?: Array<{ data: string; mediaType: string }>;
}

export interface SSEEvent {
  type: string;
  [key: string]: any;
}

// 检测 Claude CLI 路径（跨平台）
const { executable: CLAUDE_EXECUTABLE, cliPath: CLAUDE_CLI_PATH } = detectClaudeCliPath();

// 构造消息内容（支持图文混合）
type MessageContent = string | Array<{ type: string; text?: string; source?: any }>;

function buildMessageContent(
  message: string,
  images?: Array<{ data: string; mediaType: string }>
): MessageContent {
  if (!images || images.length === 0) {
    return message;
  }

  const content: Array<{ type: string; text?: string; source?: any }> = [];

  // 添加文本
  if (message) {
    content.push({ type: 'text', text: message });
  }

  // 添加图片
  for (const img of images) {
    content.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mediaType,
        data: img.data,
      },
    });
  }

  return content;
}

// 创建 SDKUserMessage 的 AsyncIterable
async function* createUserMessageIterable(
  content: MessageContent
): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: content as any,
    },
    parent_tool_use_id: null,
  };
}

/**
 * 多用户 Adapter（基于 Claude Code SDK）
 */
export class MultiUserAdapter {
  private linuxUser: string;
  private isDev: boolean;

  constructor(linuxUser: string) {
    this.linuxUser = linuxUser;
    this.isDev = process.env.NODE_ENV === 'development';
  }

  /**
   * 发送消息并流式返回响应
   */
  async *chat(params: ChatParams): AsyncIterable<SSEEvent> {
    const { message, sessionId, cwd, images } = params;

    // 构造 SDK 选项
    const sdkOptions: Parameters<typeof query>[0]['options'] = {
      pathToClaudeCodeExecutable: CLAUDE_CLI_PATH,
      cwd: cwd || process.cwd(),
      resume: sessionId || undefined,
      permissionMode: 'bypassPermissions',
    };

    // 如果检测到需要用 node 执行（npm 全局安装），设置 executable
    if (CLAUDE_EXECUTABLE === 'node') {
      sdkOptions.executable = 'node' as const;
    }

    // 构造消息内容（纯文本或图文混合）
    const content = buildMessageContent(message, images);

    // 根据内容类型选择 prompt 格式
    let prompt: string | AsyncIterable<SDKUserMessage>;

    if (typeof content === 'string') {
      prompt = content;
    } else {
      prompt = createUserMessageIterable(content);
    }

    console.log(`[Adapter] 调用 Claude Code SDK (cwd: ${cwd})`);

    for await (const sdkMessage of query({
      prompt,
      options: sdkOptions,
    })) {
      yield sdkMessage as SSEEvent;
    }
  }

  /**
   * 获取用户工作目录
   */
  getWorkspaceDir(): string {
    if (this.isDev) {
      return `/tmp/mycc_dev/${this.linuxUser}/workspace`;
    } else {
      return `/home/${this.linuxUser}/workspace`;
    }
  }
}
