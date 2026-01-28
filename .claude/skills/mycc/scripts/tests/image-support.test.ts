/**
 * 图片消息支持测试
 *
 * 测试范围：
 * 1. 图片校验（格式、大小、数量）
 * 2. 消息构造（纯文本、图文混合、仅图片）
 * 3. HTTP 错误码（413、415）
 */

import { describe, it, expect } from "vitest";
import {
  validateImage,
  validateImages,
  buildMessageContent,
  type ImageData,
} from "../src/image-utils";

// ============ 测试数据 ============

// 1x1 透明 PNG（最小的有效 PNG，约 68 字节）
const VALID_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

// 1x1 白色 JPEG（最小的有效 JPEG）
const VALID_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAwEPwAB//9k=";

// 1x1 WebP
const VALID_WEBP_BASE64 = "UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";

// 构造指定大小的 base64（用于大小测试）
function makeBase64OfSize(sizeBytes: number): string {
  // base64 编码后会变大约 4/3 倍，所以原始数据要小一点
  const rawSize = Math.floor(sizeBytes);
  const buffer = Buffer.alloc(rawSize, "A");
  return buffer.toString("base64");
}

// ============ validateImage 单张校验 ============

describe("validateImage", () => {
  describe("格式校验", () => {
    it("PNG 格式通过", () => {
      const result = validateImage({
        data: VALID_PNG_BASE64,
        mediaType: "image/png",
      });
      expect(result.valid).toBe(true);
    });

    it("JPEG 格式通过", () => {
      const result = validateImage({
        data: VALID_JPEG_BASE64,
        mediaType: "image/jpeg",
      });
      expect(result.valid).toBe(true);
    });

    it("WebP 格式通过", () => {
      const result = validateImage({
        data: VALID_WEBP_BASE64,
        mediaType: "image/webp",
      });
      expect(result.valid).toBe(true);
    });

    it("GIF 格式拒绝", () => {
      const result = validateImage({
        data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        mediaType: "image/gif",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("不支持的图片格式");
      expect(result.code).toBe(415);
    });

    it("BMP 格式拒绝", () => {
      const result = validateImage({
        data: "Qk0=",
        mediaType: "image/bmp",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("不支持的图片格式");
      expect(result.code).toBe(415);
    });

    it("空 mediaType 拒绝", () => {
      const result = validateImage({
        data: VALID_PNG_BASE64,
        mediaType: "" as any,
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe(415);
    });

    it("image/jpg 作为 jpeg 别名通过", () => {
      const result = validateImage({
        data: VALID_JPEG_BASE64,
        mediaType: "image/jpg" as any,
      });
      expect(result.valid).toBe(true);
    });

    it("大小写不敏感：IMAGE/PNG 通过", () => {
      const result = validateImage({
        data: VALID_PNG_BASE64,
        mediaType: "IMAGE/PNG" as any,
      });
      expect(result.valid).toBe(true);
    });

    it("大小写不敏感：Image/Jpeg 通过", () => {
      const result = validateImage({
        data: VALID_JPEG_BASE64,
        mediaType: "Image/Jpeg" as any,
      });
      expect(result.valid).toBe(true);
    });
  });

  describe("大小校验", () => {
    it("小于 4MB 通过", () => {
      // 100KB
      const result = validateImage({
        data: makeBase64OfSize(100 * 1024),
        mediaType: "image/png",
      });
      expect(result.valid).toBe(true);
    });

    it("刚好 4MB 通过", () => {
      const result = validateImage({
        data: makeBase64OfSize(4 * 1024 * 1024),
        mediaType: "image/png",
      });
      expect(result.valid).toBe(true);
    });

    it("超过 4MB 拒绝", () => {
      // 4MB + 1 字节
      const result = validateImage({
        data: makeBase64OfSize(4 * 1024 * 1024 + 1),
        mediaType: "image/png",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("图片太大");
      expect(result.code).toBe(413);
    });

    it("5MB 拒绝", () => {
      const result = validateImage({
        data: makeBase64OfSize(5 * 1024 * 1024),
        mediaType: "image/png",
      });
      expect(result.valid).toBe(false);
      expect(result.code).toBe(413);
    });
  });

  describe("边界情况", () => {
    it("空 data 拒绝", () => {
      const result = validateImage({
        data: "",
        mediaType: "image/png",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("图片数据为空");
    });

    it("无效 base64 拒绝", () => {
      const result = validateImage({
        data: "这不是base64!!!",
        mediaType: "image/png",
      });
      expect(result.valid).toBe(false);
      expect(result.error).toContain("无效的 base64");
    });
  });
});

// ============ validateImages 数组校验 ============

describe("validateImages", () => {
  it("空数组通过（不传图片）", () => {
    const result = validateImages([]);
    expect(result.valid).toBe(true);
  });

  it("undefined 通过（不传图片）", () => {
    const result = validateImages(undefined);
    expect(result.valid).toBe(true);
  });

  it("null 通过（不传图片）", () => {
    const result = validateImages(null as any);
    expect(result.valid).toBe(true);
  });

  it("1 张图片通过", () => {
    const result = validateImages([
      { data: VALID_PNG_BASE64, mediaType: "image/png" },
    ]);
    expect(result.valid).toBe(true);
  });

  it("2 张图片拒绝", () => {
    const result = validateImages([
      { data: VALID_PNG_BASE64, mediaType: "image/png" },
      { data: VALID_JPEG_BASE64, mediaType: "image/jpeg" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.error).toContain("最多只能上传 1 张图片");
    expect(result.code).toBe(400);
  });

  it("1 张无效图片拒绝（格式错误透传）", () => {
    const result = validateImages([
      { data: VALID_PNG_BASE64, mediaType: "image/gif" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.code).toBe(415);
  });

  it("1 张无效图片拒绝（大小错误透传）", () => {
    const result = validateImages([
      { data: makeBase64OfSize(5 * 1024 * 1024), mediaType: "image/png" },
    ]);
    expect(result.valid).toBe(false);
    expect(result.code).toBe(413);
  });
});

// ============ buildMessageContent 消息构造 ============

describe("buildMessageContent", () => {
  describe("纯文本消息", () => {
    it("没有图片，返回纯文本", () => {
      const result = buildMessageContent("你好", []);
      expect(result).toBe("你好");
    });

    it("images 为 undefined，返回纯文本", () => {
      const result = buildMessageContent("你好", undefined);
      expect(result).toBe("你好");
    });
  });

  describe("图文混合消息", () => {
    it("文本 + 图片，返回 multimodal 数组", () => {
      const result = buildMessageContent("这是什么？", [
        { data: VALID_PNG_BASE64, mediaType: "image/png" },
      ]);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);

      // 第一个是图片
      const imageBlock = (result as any[])[0];
      expect(imageBlock.type).toBe("image");
      expect(imageBlock.source.type).toBe("base64");
      expect(imageBlock.source.media_type).toBe("image/png");
      expect(imageBlock.source.data).toBe(VALID_PNG_BASE64);

      // 第二个是文本
      const textBlock = (result as any[])[1];
      expect(textBlock.type).toBe("text");
      expect(textBlock.text).toBe("这是什么？");
    });

    it("图片在前，文本在后", () => {
      const result = buildMessageContent("分析一下", [
        { data: VALID_JPEG_BASE64, mediaType: "image/jpeg" },
      ]) as any[];

      expect(result[0].type).toBe("image");
      expect(result[1].type).toBe("text");
    });
  });

  describe("仅图片消息", () => {
    it("空文本 + 图片，使用默认提示语", () => {
      const result = buildMessageContent("", [
        { data: VALID_PNG_BASE64, mediaType: "image/png" },
      ]) as any[];

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe("image");
      expect(result[1].type).toBe("text");
      expect(result[1].text).toBe("请分析这张图片");
    });

    it("空白文本 + 图片，使用默认提示语", () => {
      const result = buildMessageContent("   ", [
        { data: VALID_PNG_BASE64, mediaType: "image/png" },
      ]) as any[];

      expect(result[1].text).toBe("请分析这张图片");
    });
  });
});
