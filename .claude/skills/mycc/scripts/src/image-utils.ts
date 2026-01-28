/**
 * 图片处理工具函数
 *
 * 提供图片校验和消息构造功能
 */

// ============ 类型定义 ============

/** 图片数据 */
export interface ImageData {
  data: string; // base64 编码（不含 data:image/xxx;base64, 前缀）
  mediaType: string; // MIME 类型
}

/** 校验结果 */
export interface ValidationResult {
  valid: boolean;
  error?: string;
  code?: number; // HTTP 状态码
}

/** Anthropic API 图片块 */
interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

/** Anthropic API 文本块 */
interface TextBlock {
  type: "text";
  text: string;
}

/** 消息内容类型 */
export type MessageContent = string | (ImageBlock | TextBlock)[];

// ============ 常量 ============

/** 支持的图片格式 */
const SUPPORTED_FORMATS = ["image/png", "image/jpeg", "image/webp", "image/jpg"];

/** 最大图片大小（字节）：4MB */
const MAX_IMAGE_SIZE = 4 * 1024 * 1024;

/** 最大图片数量 */
const MAX_IMAGE_COUNT = 1;

/** 默认提示语（仅图片时使用） */
const DEFAULT_IMAGE_PROMPT = "请分析这张图片";

// ============ 校验函数 ============

/**
 * 校验单张图片
 */
export function validateImage(image: ImageData): ValidationResult {
  // 1. 检查 data 是否为空
  if (!image.data || image.data.trim() === "") {
    return {
      valid: false,
      error: "图片数据为空",
      code: 400,
    };
  }

  // 2. 检查 mediaType 格式（大小写不敏感）
  const normalizedType = image.mediaType?.toLowerCase();

  // 处理 jpg 别名
  const effectiveType = normalizedType === "image/jpg" ? "image/jpeg" : normalizedType;

  if (!effectiveType || !SUPPORTED_FORMATS.includes(effectiveType)) {
    return {
      valid: false,
      error: `不支持的图片格式: ${image.mediaType}，仅支持 PNG、JPEG、WebP`,
      code: 415,
    };
  }

  // 3. 检查 base64 是否有效并计算大小
  let decodedSize: number;

  // 先用正则检查是否是有效的 base64 字符
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(image.data)) {
    return {
      valid: false,
      error: "无效的 base64 编码",
      code: 400,
    };
  }

  try {
    const buffer = Buffer.from(image.data, "base64");
    decodedSize = buffer.length;
  } catch {
    return {
      valid: false,
      error: "无效的 base64 编码",
      code: 400,
    };
  }

  // 4. 检查大小
  if (decodedSize > MAX_IMAGE_SIZE) {
    const sizeMB = (decodedSize / 1024 / 1024).toFixed(2);
    return {
      valid: false,
      error: `图片太大: ${sizeMB}MB，最大支持 4MB`,
      code: 413,
    };
  }

  return { valid: true };
}

/**
 * 校验图片数组
 */
export function validateImages(
  images: ImageData[] | undefined | null
): ValidationResult {
  // 空数组或 undefined/null 都是合法的（纯文本消息）
  if (!images || images.length === 0) {
    return { valid: true };
  }

  // 检查数量
  if (images.length > MAX_IMAGE_COUNT) {
    return {
      valid: false,
      error: `最多只能上传 ${MAX_IMAGE_COUNT} 张图片，当前 ${images.length} 张`,
      code: 400,
    };
  }

  // 逐个校验
  for (const image of images) {
    const result = validateImage(image);
    if (!result.valid) {
      return result;
    }
  }

  return { valid: true };
}

// ============ 消息构造函数 ============

/**
 * 构造消息内容
 *
 * - 纯文本：返回 string
 * - 图文混合：返回 [ImageBlock, TextBlock]
 * - 仅图片：返回 [ImageBlock, TextBlock]（使用默认提示语）
 */
export function buildMessageContent(
  message: string,
  images: ImageData[] | undefined | null
): MessageContent {
  // 没有图片，返回纯文本
  if (!images || images.length === 0) {
    return message;
  }

  // 有图片，构造 multimodal 内容
  const content: (ImageBlock | TextBlock)[] = [];

  // 添加图片块（图片在前）
  for (const image of images) {
    // 处理 mediaType 大小写和别名
    let mediaType = image.mediaType.toLowerCase();
    if (mediaType === "image/jpg") {
      mediaType = "image/jpeg";
    }

    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType,
        data: image.data,
      },
    });
  }

  // 添加文本块
  const text = message.trim() || DEFAULT_IMAGE_PROMPT;
  content.push({
    type: "text",
    text,
  });

  return content;
}
