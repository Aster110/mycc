/**
 * 微信通道
 *
 * 通过微信 iLink Bot API 实现双向通信：
 * - 接收：long-poll getUpdates 接收微信消息
 * - 发送：sendMessage 发送回复（支持主动发消息）
 * - 状态：sendTyping 发送输入状态指示
 * - 配置：getConfig 获取 typing ticket 等
 *
 * 基于微信 iLink Bot HTTP API，直接集成到 mycc 体系。
 * API 协议参考：@tencent-weixin/openclaw-weixin
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MessageChannel } from "./interface.js";
import type { SSEEvent } from "../adapters/interface.js";

// ── 常量 ──────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const DEFAULT_BOT_TYPE = "3";
const CHANNEL_VERSION = "0.2.0";
const LONG_POLL_TIMEOUT_MS = 35_000;
const API_TIMEOUT_MS = 15_000;
const CONFIG_TIMEOUT_MS = 10_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAY_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
const SESSION_EXPIRED_ERRCODE = -14;
const SESSION_PAUSE_MS = 10 * 60_000;
const CONFIG_CACHE_TTL_MS = 24 * 60 * 60_000;

// ── 类型 ──────────────────────────────────────────────────────────────────

const MessageItemType = { NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MessageType = { NONE: 0, USER: 1, BOT: 2 } as const;
const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 } as const;
const UploadMediaType = { IMAGE: 1, VIDEO: 2, FILE: 3, VOICE: 4 } as const;
const TypingStatus = { TYPING: 1, CANCEL: 2 } as const;

interface BaseInfo {
  channel_version?: string;
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
  encrypt_type?: number;
}

interface ImageItem {
  media?: CDNMedia;
  thumb_media?: CDNMedia;
  aeskey?: string;
  url?: string;
  mid_size?: number;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
  hd_size?: number;
}

interface VoiceItem {
  media?: CDNMedia;
  encode_type?: number;
  bits_per_sample?: number;
  sample_rate?: number;
  playtime?: number;
  text?: string;
}

interface FileItem {
  media?: CDNMedia;
  file_name?: string;
  md5?: string;
  len?: string;
}

interface VideoItem {
  media?: CDNMedia;
  video_size?: number;
  play_length?: number;
  video_md5?: string;
  thumb_media?: CDNMedia;
  thumb_size?: number;
  thumb_height?: number;
  thumb_width?: number;
}

interface RefMessage {
  message_item?: MessageItem;
  title?: string;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: ImageItem;
  voice_item?: VoiceItem;
  file_item?: FileItem;
  video_item?: VideoItem;
  ref_msg?: RefMessage;
}

interface GetUploadUrlResp {
  upload_param?: string;
  thumb_upload_param?: string;
  filekey?: string;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface GetUpdatesResp {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

interface GetConfigResp {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

interface WeixinAccountData {
  token?: string;
  baseUrl?: string;
  userId?: string;
  accountId?: string;
  savedAt?: string;
}

export interface WeixinChannelConfig {
  stateDir: string;
  baseUrl?: string;
}

// ── base_info ─────────────────────────────────────────────────────────────

function buildBaseInfo(): BaseInfo {
  return { channel_version: CHANNEL_VERSION };
}

// ── API 层 ────────────────────────────────────────────────────────────────

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(opts: { token?: string; body: string }): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body?: string;
  token?: string;
  timeoutMs: number;
  label: string;
  method?: string;
}): Promise<string> {
  const base = params.baseUrl.endsWith("/") ? params.baseUrl : `${params.baseUrl}/`;
  const url = new URL(params.endpoint, base);
  const method = params.method ?? "POST";
  const isGet = method === "GET";

  const headers: Record<string, string> = isGet
    ? {
        AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": randomWechatUin(),
        ...(params.token?.trim() ? { Authorization: `Bearer ${params.token.trim()}` } : {}),
      }
    : buildHeaders({ token: params.token, body: params.body ?? "" });

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method,
      headers,
      ...(isGet ? {} : { body: params.body }),
      signal: controller.signal,
    });
    clearTimeout(t);
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText}`);
    }
    return rawText;
  } catch (err) {
    clearTimeout(t);
    throw err;
  }
}

async function apiGetUpdates(params: {
  baseUrl: string;
  token?: string;
  getUpdatesBuf: string;
  timeoutMs?: number;
}): Promise<GetUpdatesResp> {
  const timeout = params.timeoutMs ?? LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: "ilink/bot/getupdates",
      body: JSON.stringify({
        get_updates_buf: params.getUpdatesBuf,
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs: timeout,
      label: "getUpdates",
    });
    return JSON.parse(rawText);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
    }
    throw err;
  }
}

async function apiSendMessage(params: {
  baseUrl: string;
  token?: string;
  to: string;
  text: string;
  contextToken?: string;
}): Promise<string> {
  const clientId = `mycc-wx-${crypto.randomUUID()}`;
  const items: Array<{ type: number; text_item: { text: string } }> = params.text
    ? [{ type: MessageItemType.TEXT, text_item: { text: params.text } }]
    : [];

  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: params.to,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: items.length ? items : undefined,
        context_token: params.contextToken,
      },
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: API_TIMEOUT_MS,
    label: "sendMessage",
  });
  return clientId;
}

async function apiGetConfig(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  contextToken?: string;
}): Promise<GetConfigResp> {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getconfig",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      context_token: params.contextToken,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: CONFIG_TIMEOUT_MS,
    label: "getConfig",
  });
  return JSON.parse(rawText);
}

async function apiSendTyping(params: {
  baseUrl: string;
  token?: string;
  ilinkUserId: string;
  typingTicket: string;
  status: number;
}): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/sendtyping",
    body: JSON.stringify({
      ilink_user_id: params.ilinkUserId,
      typing_ticket: params.typingTicket,
      status: params.status,
      base_info: buildBaseInfo(),
    }),
    token: params.token,
    timeoutMs: CONFIG_TIMEOUT_MS,
    label: "sendTyping",
  });
}

// ── CDN 媒体操作 ─────────────────────────────────────────────────────────

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function detectExtByMagic(buf: Buffer): string {
  if (buf.length < 4) return "";
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return ".jpg";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return ".png";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return ".gif";
  if (buf[0] === 0x42 && buf[1] === 0x4D) return ".bmp";
  if (buf.length >= 12 && buf[0] === 0x52 && buf[1] === 0x49 && buf[8] === 0x57 && buf[9] === 0x45) return ".webp";
  if (buf.length >= 8 && buf[4] === 0x66 && buf[5] === 0x74 && buf[6] === 0x79 && buf[7] === 0x70) return ".mp4";
  if (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46) return ".pdf";
  return "";
}

function detectMediaType(filePath: string): number {
  const ext = path.extname(filePath).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"].includes(ext)) return UploadMediaType.IMAGE;
  if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) return UploadMediaType.VIDEO;
  return UploadMediaType.FILE;
}

async function apiGetUploadUrl(params: {
  baseUrl: string;
  token: string;
  uploadParams: Record<string, unknown>;
}): Promise<GetUploadUrlResp> {
  const rawText = await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: "ilink/bot/getuploadurl",
    body: JSON.stringify({ ...params.uploadParams, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: API_TIMEOUT_MS,
    label: "getUploadUrl",
  });
  return JSON.parse(rawText);
}

async function apiUploadMedia(params: {
  baseUrl: string;
  token: string;
  toUser: string;
  contextToken?: string;
  filePath: string;
}): Promise<void> {
  const { baseUrl, token, toUser, contextToken, filePath } = params;

  const fileData = fs.readFileSync(filePath);
  const rawsize = fileData.length;
  const rawfilemd5 = crypto.createHash("md5").update(fileData).digest("hex");

  const aesKey = crypto.randomBytes(16);
  const mediaType = detectMediaType(filePath);
  const ciphertext = encryptAesEcb(fileData, aesKey);

  const extname = path.extname(filePath);
  const rand = crypto.randomBytes(3).toString("hex");
  const filekey = `mycc-wx-${Date.now()}-${rand}${extname}`;

  console.log(`[uploadMedia] 文件: ${path.basename(filePath)}, 大小: ${rawsize}, 加密后: ${ciphertext.length}, 类型: ${mediaType}`);
  const uploadResp = await apiGetUploadUrl({
    baseUrl,
    token,
    uploadParams: {
      filekey,
      media_type: mediaType,
      to_user_id: toUser,
      rawsize,
      rawfilemd5,
      filesize: ciphertext.length,
      no_need_thumb: true,
      aeskey: aesKey.toString("hex"),
    },
  });

  const uploadParam = uploadResp.upload_param ?? "";
  const serverFilekey = uploadResp.filekey ?? filekey;

  const cdnUrl =
    `${CDN_BASE_URL}/upload` +
    `?encrypted_query_param=${encodeURIComponent(uploadParam)}` +
    `&filekey=${encodeURIComponent(serverFilekey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let downloadParam: string;
  try {
    const cdnResp = await fetch(cdnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
      },
      body: new Uint8Array(ciphertext),
      signal: controller.signal,
    });
    if (!cdnResp.ok) {
      const errText = await cdnResp.text();
      throw new Error(`[uploadMedia] CDN HTTP ${cdnResp.status}: ${errText}`);
    }
    downloadParam = cdnResp.headers.get("x-encrypted-param") ?? "";
    console.log(`[uploadMedia] CDN 上传成功, downloadParam长度: ${downloadParam.length}`);
  } finally {
    clearTimeout(timer);
  }

  const aesKeyBase64 = Buffer.from(aesKey.toString("hex")).toString("base64");
  const mediaInfo: CDNMedia = {
    encrypt_query_param: downloadParam,
    aes_key: aesKeyBase64,
    encrypt_type: 1,
  };

  let mediaItem: Record<string, unknown>;
  if (mediaType === UploadMediaType.IMAGE) {
    mediaItem = { type: MessageItemType.IMAGE, image_item: { media: mediaInfo, mid_size: ciphertext.length } };
  } else if (mediaType === UploadMediaType.VIDEO) {
    mediaItem = { type: MessageItemType.VIDEO, video_item: { media: mediaInfo, video_size: ciphertext.length } };
  } else {
    mediaItem = {
      type: MessageItemType.FILE,
      file_item: {
        media: mediaInfo,
        file_name: path.basename(filePath),
        len: String(rawsize),
        md5: rawfilemd5,
      },
    };
  }

  const clientId = `mycc-wx-${crypto.randomUUID()}`;
  await apiFetch({
    baseUrl,
    endpoint: "ilink/bot/sendmessage",
    body: JSON.stringify({
      msg: {
        from_user_id: "",
        to_user_id: toUser,
        client_id: clientId,
        message_type: MessageType.BOT,
        message_state: MessageState.FINISH,
        item_list: [mediaItem],
        context_token: contextToken,
      },
      base_info: buildBaseInfo(),
    }),
    token,
    timeoutMs: API_TIMEOUT_MS,
    label: "uploadMedia",
  });
}

async function apiDownloadMedia(params: {
  encryptQueryParam: string;
  aesKeyBase64: string;
  outDir?: string;
  fileName?: string;
}): Promise<string> {
  const { encryptQueryParam, aesKeyBase64, outDir, fileName } = params;

  const downloadUrl =
    `${CDN_BASE_URL}/download` +
    `?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let ciphertext: Buffer;
  try {
    const resp = await fetch(downloadUrl, { signal: controller.signal });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`[downloadMedia] CDN HTTP ${resp.status}: ${errText}`);
    }
    ciphertext = Buffer.from(await resp.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }

  const hexStr = Buffer.from(aesKeyBase64, "base64").toString("utf-8");
  const aesKey = Buffer.from(hexStr, "hex");
  const plaintext = decryptAesEcb(ciphertext, aesKey);

  const ext = detectExtByMagic(plaintext);
  const targetDir = outDir ?? path.join(os.tmpdir(), "mycc-weixin", "media");
  fs.mkdirSync(targetDir, { recursive: true });

  let targetName = fileName ?? `media-${Date.now()}`;
  if (!path.extname(targetName) && ext) {
    targetName += ext;
  }
  const targetPath = path.join(targetDir, targetName);
  fs.writeFileSync(targetPath, plaintext);

  return path.resolve(targetPath);
}

// ── QR 登录 ───────────────────────────────────────────────────────────────

async function fetchQRCode(apiBaseUrl: string): Promise<{ qrcode: string; qrcodeUrl: string }> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${DEFAULT_BOT_TYPE}`, base);
  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`获取二维码失败: ${response.status}`);
  }
  const data = await response.json() as { qrcode: string; qrcode_img_content: string };
  return { qrcode: data.qrcode, qrcodeUrl: data.qrcode_img_content };
}

async function pollQRStatus(apiBaseUrl: string, qrcode: string): Promise<{
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}> {
  const base = apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`;
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LONG_POLL_TIMEOUT_MS);
  try {
    const response = await fetch(url.toString(), {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const rawText = await response.text();
    if (!response.ok) {
      throw new Error(`轮询二维码状态失败: ${response.status}`);
    }
    return JSON.parse(rawText);
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
}

// ── 消息解析 ──────────────────────────────────────────────────────────────

function stripMarkdown(text: string): string {
  let result = text;
  result = result.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_, code: string) => code.trim());
  result = result.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  result = result.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  result = result.replace(/^\|[\s:|-]+\|$/gm, "");
  result = result.replace(/^\|(.+)\|$/gm, (_, inner: string) =>
    inner.split("|").map((cell) => cell.trim()).join("  "),
  );
  result = result.replace(/\*\*(.+?)\*\*/g, "$1");
  result = result.replace(/\*(.+?)\*/g, "$1");
  result = result.replace(/__(.+?)__/g, "$1");
  result = result.replace(/_(.+?)_/g, "$1");
  result = result.replace(/~~(.+?)~~/g, "$1");
  result = result.replace(/`(.+?)`/g, "$1");
  result = result.replace(/^#{1,6}\s+/gm, "");
  result = result.replace(/^>\s?/gm, "");
  result = result.replace(/^[-*+]\s/gm, "• ");
  return result;
}

// ── typing ticket 缓存 ──────────────────────────────────────────────────

interface TypingCacheEntry {
  ticket: string;
  fetchedAt: number;
}

// ── 微信通道 ──────────────────────────────────────────────────────────────

export class WeixinChannel implements MessageChannel {
  readonly id = "weixin";

  private config: WeixinChannelConfig;
  private account: WeixinAccountData | null = null;
  private abortController: AbortController | null = null;
  private messageCallback: ((message: string) => void) | null = null;
  private contextTokenStore = new Map<string, string>();
  private typingTicketCache = new Map<string, TypingCacheEntry>();
  private getUpdatesBuf = "";
  private sessionPausedUntil = 0;
  private lastFromUserId: string | null = null;

  constructor(config: WeixinChannelConfig) {
    this.config = config;
  }

  // ── MessageChannel 接口 ──

  filter(_event: SSEEvent): boolean {
    return false;
  }

  async send(_event: SSEEvent): Promise<void> {
    // 微信通道不通过 broadcast 发送消息
  }

  // ── 消息回调 ──

  onMessage(callback: (message: string) => void): void {
    this.messageCallback = callback;
  }

  // ── 生命周期 ──

  async start(): Promise<void> {
    this.account = this.loadAccount();
    if (!this.account?.token) {
      console.log("[WeixinChannel] 未登录，请使用 /mycc-weixin 扫码登录");
      return;
    }

    this.getUpdatesBuf = this.loadSyncBuf();
    this.restoreContextTokens();

    console.log(`[WeixinChannel] 已加载账号: ${this.account.accountId}`);
    console.log("[WeixinChannel] 启动消息监听...");

    this.abortController = new AbortController();
    this.runMonitorLoop().catch((err) => {
      if (!this.abortController?.signal.aborted) {
        console.error("[WeixinChannel] 监听循环异常退出:", err);
      }
    });
  }

  stop(): void {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    console.log("[WeixinChannel] 已停止");
  }

  // ── QR 登录流程 ──

  async login(): Promise<boolean> {
    const baseUrl = this.config.baseUrl || DEFAULT_BASE_URL;
    console.log("[WeixinChannel] 正在获取登录二维码...");

    const { qrcode, qrcodeUrl } = await fetchQRCode(baseUrl);

    console.log("\n使用微信扫描以下二维码：\n");
    try {
      const qrterm = await import("qrcode-terminal");
      await new Promise<void>((resolve) => {
        qrterm.default.generate(qrcodeUrl, { small: true }, (qr: string) => {
          console.log(qr);
          resolve();
        });
      });
    } catch {
      console.log(`二维码链接: ${qrcodeUrl}`);
    }

    console.log("\n等待扫码...\n");
    const deadline = Date.now() + 480_000;
    let scannedPrinted = false;

    while (Date.now() < deadline) {
      const status = await pollQRStatus(baseUrl, qrcode);

      switch (status.status) {
        case "wait":
          break;
        case "scaned":
          if (!scannedPrinted) {
            console.log("已扫码，在微信中确认...");
            scannedPrinted = true;
          }
          break;
        case "expired":
          console.log("二维码已过期，请重新登录");
          return false;
        case "confirmed": {
          if (!status.ilink_bot_id || !status.bot_token) {
            console.error("登录失败：服务器未返回必要信息");
            return false;
          }
          const accountId = status.ilink_bot_id
            .replace(/@/g, "-")
            .replace(/\./g, "-");

          this.account = {
            token: status.bot_token,
            baseUrl: status.baseurl || baseUrl,
            userId: status.ilink_user_id,
            accountId,
            savedAt: new Date().toISOString(),
          };
          this.saveAccount(this.account);
          console.log("\n与微信连接成功！");
          return true;
        }
      }

      await sleep(1000);
    }

    console.log("登录超时，请重试");
    return false;
  }

  isLoggedIn(): boolean {
    if (!this.account) {
      this.account = this.loadAccount();
    }
    return Boolean(this.account?.token);
  }

  // ── typing 指示器 ──

  private async getTypingTicket(userId: string): Promise<string> {
    const cached = this.typingTicketCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < CONFIG_CACHE_TTL_MS) {
      return cached.ticket;
    }

    if (!this.account?.token) return "";

    try {
      const resp = await apiGetConfig({
        baseUrl: this.account.baseUrl || DEFAULT_BASE_URL,
        token: this.account.token,
        ilinkUserId: userId,
        contextToken: this.contextTokenStore.get(userId),
      });
      if (resp.ret === 0 && resp.typing_ticket) {
        this.typingTicketCache.set(userId, {
          ticket: resp.typing_ticket,
          fetchedAt: Date.now(),
        });
        return resp.typing_ticket;
      }
    } catch (err) {
      console.warn(`[WeixinChannel] getConfig 失败 (ignored): ${String(err)}`);
    }
    return cached?.ticket ?? "";
  }

  private async startTyping(userId: string): Promise<void> {
    const ticket = await this.getTypingTicket(userId);
    if (!ticket || !this.account?.token) return;
    try {
      await apiSendTyping({
        baseUrl: this.account.baseUrl || DEFAULT_BASE_URL,
        token: this.account.token,
        ilinkUserId: userId,
        typingTicket: ticket,
        status: TypingStatus.TYPING,
      });
    } catch {
      // 非关键操作，忽略错误
    }
  }

  private async stopTyping(userId: string): Promise<void> {
    const ticket = this.typingTicketCache.get(userId)?.ticket;
    if (!ticket || !this.account?.token) return;
    try {
      await apiSendTyping({
        baseUrl: this.account.baseUrl || DEFAULT_BASE_URL,
        token: this.account.token,
        ilinkUserId: userId,
        typingTicket: ticket,
        status: TypingStatus.CANCEL,
      });
    } catch {
      // 非关键操作，忽略错误
    }
  }

  // ── 发送回复 ──

  async sendLastReply(text: string, media?: string): Promise<void> {
    if (!this.lastFromUserId) {
      console.warn("[WeixinChannel] 无法回复：没有最近的发送者");
      return;
    }
    await this.sendReply(this.lastFromUserId, text, media);
  }

  async sendReply(to: string, text: string, media?: string): Promise<void> {
    if (!this.account?.token) {
      throw new Error("微信未登录");
    }
    const contextToken = this.contextTokenStore.get(to);
    if (!contextToken) {
      console.warn(`[WeixinChannel] 发送给 ${to}：无 contextToken，尝试无上下文发送`);
    }

    const baseUrl = this.account.baseUrl || DEFAULT_BASE_URL;
    const token = this.account.token;

    if (text) {
      const plainText = stripMarkdown(text);
      await apiSendMessage({
        baseUrl,
        token,
        to,
        text: plainText,
        contextToken,
      });
    }

    if (media) {
      if (!fs.existsSync(media)) {
        console.warn(`[WeixinChannel] 媒体文件不存在: ${media}`);
        return;
      }
      const uploadParams = { baseUrl, token, toUser: to, contextToken, filePath: media };
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await apiUploadMedia(uploadParams);
          console.log(`[WeixinChannel] 媒体文件已发送: ${path.basename(media)}`);
          break;
        } catch (err) {
          if (attempt < 2) {
            console.warn(`[WeixinChannel] 媒体发送失败(${attempt + 1}/3)，${2 * (attempt + 1)}秒后重试:`, String(err));
            await sleep(2000 * (attempt + 1));
          } else {
            console.error(`[WeixinChannel] 媒体发送失败(3/3):`, err);
          }
        }
      }
    }
  }

  /**
   * 主动发消息给指定用户（不需要先收到消息）
   * 如果有缓存的 contextToken 会使用，没有也能发送
   */
  async sendProactive(to: string, text: string, media?: string): Promise<void> {
    if (!this.account?.token) {
      throw new Error("微信未登录");
    }
    const contextToken = this.contextTokenStore.get(to);
    if (!contextToken) {
      console.log(`[WeixinChannel] 主动发消息给 ${to}（无 contextToken）`);
    }

    const baseUrl = this.account.baseUrl || DEFAULT_BASE_URL;
    const token = this.account.token;

    if (text) {
      const plainText = stripMarkdown(text);
      await apiSendMessage({ baseUrl, token, to, text: plainText, contextToken });
    }

    if (media) {
      if (!fs.existsSync(media)) {
        throw new Error(`媒体文件不存在: ${media}`);
      }
      await apiUploadMedia({ baseUrl, token, toUser: to, contextToken, filePath: media });
      console.log(`[WeixinChannel] 媒体文件已发送: ${path.basename(media)}`);
    }
  }

  /** 获取所有已知用户（有 contextToken 缓存的） */
  getKnownUsers(): string[] {
    return [...this.contextTokenStore.keys()];
  }

  /** 获取最近消息发送者的 userId */
  getLastFromUserId(): string | null {
    return this.lastFromUserId;
  }

  // ── 内部：long-poll 监听循环 ──

  private async runMonitorLoop(): Promise<void> {
    const signal = this.abortController?.signal;
    let consecutiveFailures = 0;
    let nextTimeoutMs = LONG_POLL_TIMEOUT_MS;

    console.log("[WeixinChannel] 消息监听已启动");

    while (!signal?.aborted) {
      if (Date.now() < this.sessionPausedUntil) {
        const waitMs = this.sessionPausedUntil - Date.now();
        console.log(`[WeixinChannel] session 暂停中，等待 ${Math.ceil(waitMs / 60000)} 分钟`);
        await sleep(waitMs, signal);
        continue;
      }

      try {
        const resp = await apiGetUpdates({
          baseUrl: this.account!.baseUrl || DEFAULT_BASE_URL,
          token: this.account!.token,
          getUpdatesBuf: this.getUpdatesBuf,
          timeoutMs: nextTimeoutMs,
        });

        if (resp.longpolling_timeout_ms != null && resp.longpolling_timeout_ms > 0) {
          nextTimeoutMs = resp.longpolling_timeout_ms;
        }

        const isApiError =
          (resp.ret !== undefined && resp.ret !== 0) ||
          (resp.errcode !== undefined && resp.errcode !== 0);

        if (isApiError) {
          const isExpired = resp.errcode === SESSION_EXPIRED_ERRCODE || resp.ret === SESSION_EXPIRED_ERRCODE;
          if (isExpired) {
            this.sessionPausedUntil = Date.now() + SESSION_PAUSE_MS;
            console.error(`[WeixinChannel] session 过期，暂停 ${SESSION_PAUSE_MS / 60000} 分钟`);
            consecutiveFailures = 0;
            continue;
          }

          consecutiveFailures++;
          console.error(`[WeixinChannel] getUpdates 失败: ret=${resp.ret} errcode=${resp.errcode} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            consecutiveFailures = 0;
            await sleep(BACKOFF_DELAY_MS, signal);
          } else {
            await sleep(RETRY_DELAY_MS, signal);
          }
          continue;
        }

        consecutiveFailures = 0;

        if (resp.get_updates_buf) {
          this.getUpdatesBuf = resp.get_updates_buf;
          this.saveSyncBuf(resp.get_updates_buf);
        }

        const msgs = resp.msgs ?? [];
        for (const msg of msgs) {
          await this.processInboundMessage(msg);
        }
      } catch (err) {
        if (signal?.aborted) return;
        consecutiveFailures++;
        console.error(`[WeixinChannel] getUpdates 异常 (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}):`, err);
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          consecutiveFailures = 0;
          await sleep(BACKOFF_DELAY_MS, signal);
        } else {
          await sleep(RETRY_DELAY_MS, signal);
        }
      }
    }
  }

  private async processInboundMessage(msg: WeixinMessage): Promise<void> {
    const fromUserId = msg.from_user_id ?? "";
    const parts: string[] = [];

    for (const item of msg.item_list ?? []) {
      const t = item.type ?? 0;

      if (t === MessageItemType.TEXT) {
        const textContent = item.text_item?.text;
        if (textContent) {
          const ref = item.ref_msg;
          if (ref) {
            const refParts: string[] = [];
            if (ref.title) refParts.push(ref.title);
            if (ref.message_item?.text_item?.text) refParts.push(ref.message_item.text_item.text);
            if (refParts.length) parts.push(`[引用: ${refParts.join(" | ")}]`);
          }
          parts.push(textContent);
        }
      } else if (t === MessageItemType.IMAGE) {
        let desc = "[图片]";
        if (item.image_item?.media?.encrypt_query_param && item.image_item?.media?.aes_key) {
          try {
            const filePath = await apiDownloadMedia({
              encryptQueryParam: item.image_item.media.encrypt_query_param,
              aesKeyBase64: item.image_item.media.aes_key,
            });
            desc += `\n[附件: ${filePath}]`;
          } catch {
            // 下载失败不阻塞
          }
        }
        parts.push(desc);
      } else if (t === MessageItemType.VOICE) {
        const voiceText = item.voice_item?.text;
        if (voiceText) {
          parts.push(voiceText);
        } else {
          parts.push(`[语音]`);
        }
      } else if (t === MessageItemType.FILE) {
        let desc = `[文件: ${item.file_item?.file_name ?? "unknown"}]`;
        if (item.file_item?.media?.encrypt_query_param && item.file_item?.media?.aes_key) {
          try {
            const filePath = await apiDownloadMedia({
              encryptQueryParam: item.file_item.media.encrypt_query_param,
              aesKeyBase64: item.file_item.media.aes_key,
              fileName: item.file_item.file_name,
            });
            desc += `\n[附件: ${filePath}]`;
          } catch {
            // 下载失败不阻塞
          }
        }
        parts.push(desc);
      } else if (t === MessageItemType.VIDEO) {
        let desc = "[视频]";
        if (item.video_item?.media?.encrypt_query_param && item.video_item?.media?.aes_key) {
          try {
            const filePath = await apiDownloadMedia({
              encryptQueryParam: item.video_item.media.encrypt_query_param,
              aesKeyBase64: item.video_item.media.aes_key,
            });
            desc += `\n[附件: ${filePath}]`;
          } catch {
            // 下载失败不阻塞
          }
        }
        parts.push(desc);
      }
    }

    const fullText = parts.join("\n") || "";
    if (!fullText) return;

    // 缓存 contextToken（持久化到磁盘）
    if (msg.context_token) {
      this.contextTokenStore.set(fromUserId, msg.context_token);
      this.persistContextTokens();
    }

    console.log(`[WeixinChannel] 收到消息 from=${fromUserId}: ${fullText.substring(0, 50)}${fullText.length > 50 ? "..." : ""}`);

    this.lastFromUserId = fromUserId;

    // 发送 typing 指示器
    this.startTyping(fromUserId).catch(() => {});

    if (this.messageCallback) {
      this.messageCallback(fullText);
    }
  }

  // ── context token 持久化 ──

  private getContextTokenFilePath(): string {
    return path.join(this.getStateDir(), "context-tokens.json");
  }

  private persistContextTokens(): void {
    const filePath = this.getContextTokenFilePath();
    const tokens: Record<string, string> = {};
    for (const [k, v] of this.contextTokenStore) {
      tokens[k] = v;
    }
    try {
      fs.writeFileSync(filePath, JSON.stringify(tokens), "utf-8");
    } catch (err) {
      console.warn(`[WeixinChannel] 持久化 contextToken 失败: ${String(err)}`);
    }
  }

  private restoreContextTokens(): void {
    const filePath = this.getContextTokenFilePath();
    try {
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, "utf-8");
      const tokens = JSON.parse(raw) as Record<string, string>;
      let count = 0;
      for (const [userId, token] of Object.entries(tokens)) {
        if (typeof token === "string" && token) {
          this.contextTokenStore.set(userId, token);
          count++;
        }
      }
      console.log(`[WeixinChannel] 恢复了 ${count} 个 contextToken`);
    } catch (err) {
      console.warn(`[WeixinChannel] 恢复 contextToken 失败: ${String(err)}`);
    }
  }

  // ── 持久化 ──

  private getStateDir(): string {
    const dir = path.join(this.config.stateDir, "weixin");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private loadAccount(): WeixinAccountData | null {
    const filePath = path.join(this.getStateDir(), "account.json");
    try {
      if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
      }
    } catch {
      // ignore
    }
    return null;
  }

  private saveAccount(data: WeixinAccountData): void {
    const filePath = path.join(this.getStateDir(), "account.json");
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    try { fs.chmodSync(filePath, 0o600); } catch { /* best-effort */ }
  }

  private loadSyncBuf(): string {
    const filePath = path.join(this.getStateDir(), "sync-buf.txt");
    try {
      if (fs.existsSync(filePath)) {
        return fs.readFileSync(filePath, "utf-8");
      }
    } catch {
      // ignore
    }
    return "";
  }

  private saveSyncBuf(buf: string): void {
    const filePath = path.join(this.getStateDir(), "sync-buf.txt");
    fs.writeFileSync(filePath, buf, "utf-8");
  }
}

// ── 辅助 ──

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    }, { once: true });
  });
}
