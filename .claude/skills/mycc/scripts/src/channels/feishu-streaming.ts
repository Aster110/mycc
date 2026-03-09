/**
 * 飞书流式卡片 + 工具函数
 *
 * 集成自 clawdbot-feishu（MIT License）
 * 来源: https://github.com/m1heng/clawdbot-feishu
 *
 * 主要功能：
 * - FeishuStreamingSession: 流式卡片，AI 回复实时更新到单个卡片
 * - buildMarkdownCard: 构建 schema 2.0 markdown 卡片（完整 markdown 支持）
 * - normalizeFeishuMarkdownLinks: 规范化 URL，避免飞书截断
 */

// ==================== normalizeFeishuMarkdownLinks ====================

const FENCED_CODE_BLOCK_RE = /(```[\s\S]*?```)/g;
const INLINE_CODE_RE = /(`[^`\n]*`)/g;
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCT_RE = /[.,;!?\u3002\uff0c\uff1b\uff01\uff1f\u3001]/u;
const AUTO_LINK_RE = /<\s*(https?:\/\/[^>\s]+)\s*>/g;

function normalizeUrlForFeishu(url: string): string {
  return url.replace(/_/g, "%5F").replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function buildMarkdownLink(url: string): string {
  const label = url.replace(/[\[\]]/g, "\\$&");
  return `[${label}](${url})`;
}

function countParens(text: string): { open: number; close: number } {
  let open = 0,
    close = 0;
  for (const c of text) {
    if (c === "(") open++;
    else if (c === ")") close++;
  }
  return { open, close };
}

function splitTrailingPunctuation(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl,
    trailing = "";
  let { open, close } = countParens(rawUrl);
  while (url.length > 0) {
    const tail = url.slice(-1);
    const closeParenOverflow = tail === ")" && close > open;
    if (!TRAILING_PUNCT_RE.test(tail) && !closeParenOverflow) break;
    if (tail === ")") close--;
    trailing = tail + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

function wrapBareUrls(text: string): string {
  const converted = text.replace(AUTO_LINK_RE, (_full, rawUrl: string) => {
    const { url, trailing } = splitTrailingPunctuation(rawUrl);
    if (!url) return _full;
    return `${buildMarkdownLink(normalizeUrlForFeishu(url))}${trailing}`;
  });
  return converted.replace(URL_RE, (raw, offset, input) => {
    const { url, trailing } = splitTrailingPunctuation(raw);
    if (!url) return raw;
    const isMarkdownDestination = offset >= 2 && input.slice(offset - 2, offset) === "](";
    const normalizedUrl = normalizeUrlForFeishu(url);
    if (isMarkdownDestination) return `${normalizedUrl}${trailing}`;
    return `${buildMarkdownLink(normalizedUrl)}${trailing}`;
  });
}

function normalizeNonCodeSegments(text: string): string {
  return text
    .split(INLINE_CODE_RE)
    .map((seg, idx) => (idx % 2 === 1 && seg.startsWith("`") ? seg : wrapBareUrls(seg)))
    .join("");
}

/**
 * 规范化飞书 markdown 中的 URL
 * 将裸 URL 和自动链接转换为标准 markdown 链接格式，避免飞书截断
 */
export function normalizeFeishuMarkdownLinks(text: string): string {
  if (!text || (!text.includes("http://") && !text.includes("https://"))) return text;
  return text
    .split(FENCED_CODE_BLOCK_RE)
    .map((block, idx) =>
      idx % 2 === 1 && block.startsWith("```") ? block : normalizeNonCodeSegments(block)
    )
    .join("");
}

// ==================== buildMarkdownCard ====================

/**
 * 构建飞书 schema 2.0 markdown 卡片
 * 完整支持代码块、表格、链接、加粗等 markdown 语法
 */
export function buildMarkdownCard(text: string): Record<string, unknown> {
  return {
    schema: "2.0",
    config: { wide_screen_mode: true },
    body: {
      elements: [{ tag: "markdown", content: text }],
    },
  };
}

// ==================== FeishuStreamingSession ====================

const API_BASE = "https://open.feishu.cn/open-apis";

type Credentials = { appId: string; appSecret: string };
type CardState = { cardId: string; messageId: string; sequence: number; currentText: string };

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

async function getFeishuToken(creds: Credentials): Promise<string> {
  const key = creds.appId;
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  const res = await fetch(`${API_BASE}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
  });
  const data = (await res.json()) as {
    code: number;
    msg: string;
    tenant_access_token?: string;
    expire?: number;
  };
  if (data.code !== 0 || !data.tenant_access_token)
    throw new Error(`Token error: ${data.msg}`);
  tokenCache.set(key, {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire ?? 7200) * 1000,
  });
  return data.tenant_access_token;
}

function truncateSummary(text: string, max = 50): string {
  const clean = text.replace(/\n/g, " ").trim();
  return clean.length <= max ? clean : clean.slice(0, max - 3) + "...";
}

function mergeStreamingText(
  prev: string | undefined,
  next: string | undefined
): string {
  const p = typeof prev === "string" ? prev : "";
  const n = typeof next === "string" ? next : "";
  if (!n) return p;
  if (!p || n === p || n.includes(p)) return n;
  if (p.includes(n)) return p;
  return p + n;
}

/**
 * 飞书流式卡片会话
 *
 * 用法：
 * 1. session.start(receiveId, receiveIdType, replyToMessageId?)
 * 2. session.update(text)  // 随文本增长调用
 * 3. session.close(finalText?)
 *
 * 如果 CardKit API 不可用（权限不足等），会抛出错误，
 * 调用方应降级到普通消息发送。
 */
export class FeishuStreamingSession {
  private creds: Credentials;
  private state: CardState | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  private lastUpdateTime = 0;
  private pendingText: string | null = null;
  private readonly updateThrottleMs = 100;
  private log?: (msg: string) => void;

  constructor(creds: Credentials, log?: (msg: string) => void) {
    this.creds = creds;
    this.log = log;
  }

  async start(
    receiveId: string,
    receiveIdType: "open_id" | "user_id" | "union_id" | "email" | "chat_id",
    replyToMessageId?: string
  ): Promise<void> {
    if (this.state) return;

    const token = await getFeishuToken(this.creds);

    // 创建流式卡片（streaming_mode: true）
    const cardJson = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[生成中...]" },
        streaming_config: {
          print_frequency_ms: { default: 50 },
          print_step: { default: 2 },
        },
      },
      body: {
        elements: [{ tag: "markdown", content: "思考中...", element_id: "content" }],
      },
    };

    const createRes = await fetch(`${API_BASE}/cardkit/v1/cards`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "card_json", data: JSON.stringify(cardJson) }),
    });
    const createData = (await createRes.json()) as {
      code: number;
      msg: string;
      data?: { card_id: string };
    };
    if (createData.code !== 0 || !createData.data?.card_id) {
      throw new Error(
        `CardKit 创建卡片失败 (code ${createData.code}): ${createData.msg}`
      );
    }
    const cardId = createData.data.card_id;

    // 发送卡片（或回复消息）
    const cardContent = JSON.stringify({ type: "card", data: { card_id: cardId } });
    const sendUrl = replyToMessageId
      ? `${API_BASE}/im/v1/messages/${replyToMessageId}/reply`
      : `${API_BASE}/im/v1/messages?receive_id_type=${receiveIdType}`;
    const sendBody = replyToMessageId
      ? { msg_type: "interactive", content: cardContent }
      : { receive_id: receiveId, msg_type: "interactive", content: cardContent };

    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(sendBody),
    });
    const sendData = (await sendRes.json()) as {
      code: number;
      msg: string;
      data?: { message_id: string };
    };
    if (sendData.code !== 0 || !sendData.data?.message_id) {
      throw new Error(
        `发送卡片失败 (code ${sendData.code}): ${sendData.msg}`
      );
    }

    this.state = {
      cardId,
      messageId: sendData.data.message_id,
      sequence: 1,
      currentText: "",
    };
    this.log?.(`[Streaming] 已启动: cardId=${cardId}, messageId=${sendData.data.message_id}`);
  }

  async update(text: string): Promise<void> {
    if (!this.state || this.closed) return;
    const merged = mergeStreamingText(
      this.pendingText ?? this.state.currentText,
      text
    );
    if (!merged || merged === this.state.currentText) return;

    const now = Date.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      this.pendingText = merged;
      return;
    }
    this.pendingText = null;
    this.lastUpdateTime = now;

    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) return;
      const mergedText = mergeStreamingText(this.state.currentText, merged);
      if (!mergedText || mergedText === this.state.currentText) return;
      this.state.currentText = mergedText;
      this.state.sequence += 1;
      await fetch(
        `${API_BASE}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${await getFeishuToken(this.creds)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: mergedText,
            sequence: this.state.sequence,
            uuid: `s_${this.state.cardId}_${this.state.sequence}`,
          }),
        }
      ).catch((e) => this.log?.(`Update failed: ${String(e)}`));
    });
    await this.queue;
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) return;
    this.closed = true;
    await this.queue;

    const pendingMerged = mergeStreamingText(
      this.state.currentText,
      this.pendingText ?? undefined
    );
    const text = finalText
      ? mergeStreamingText(pendingMerged, finalText)
      : pendingMerged;
    const token = await getFeishuToken(this.creds);

    // 最终文本更新
    if (text && text !== this.state.currentText) {
      this.state.sequence += 1;
      await fetch(
        `${API_BASE}/cardkit/v1/cards/${this.state.cardId}/elements/content/content`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            content: text,
            sequence: this.state.sequence,
            uuid: `s_${this.state.cardId}_${this.state.sequence}`,
          }),
        }
      ).catch(() => {});
      this.state.currentText = text;
    }

    // 关闭流式模式
    const summary = text ? truncateSummary(text) : "";
    this.state.sequence += 1;
    await fetch(`${API_BASE}/cardkit/v1/cards/${this.state.cardId}/settings`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        settings: JSON.stringify({
          config: {
            streaming_mode: false,
            summary: { content: summary },
          },
        }),
        sequence: this.state.sequence,
        uuid: `c_${this.state.cardId}_${this.state.sequence}`,
      }),
    }).catch((e) => this.log?.(`Close failed: ${String(e)}`));

    this.log?.(`[Streaming] 已完成: cardId=${this.state.cardId}`);
  }

  isActive(): boolean {
    return this.state !== null && !this.closed;
  }
}
