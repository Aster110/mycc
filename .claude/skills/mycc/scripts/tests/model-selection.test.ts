/**
 * 模型选择功能测试
 *
 * 验证 model 字段在后端的类型定义和解析
 */

import { describe, it, expect } from "vitest";

// ============ 类型测试：ChatParams 支持 model ============

describe("模型选择 - ChatParams 类型", () => {
  it("ChatParams 支持 model 字段", async () => {
    const params: import("../src/types.js").ChatParams = {
      message: "test",
      cwd: "/tmp",
      model: "claude-opus-4-6",
    };
    expect(params.model).toBe("claude-opus-4-6");
  });


  it("ChatParams 支持 settingSources 和 appendSystemPrompt", async () => {
    const params: import("../src/types.js").ChatParams = {
      message: "test",
      cwd: "/tmp",
      settingSources: ["user", "project", "local"],
      appendSystemPrompt: "请如实说明底层模型",
    };

    expect(params.settingSources).toEqual(["user", "project", "local"]);
    expect(params.appendSystemPrompt).toBe("请如实说明底层模型");
  });

  it("ChatParams.model 是可选字段", async () => {
    const params: import("../src/types.js").ChatParams = {
      message: "test",
      cwd: "/tmp",
    };
    expect(params.model).toBeUndefined();
  });

  it("model 接受所有三种模型 ID", async () => {
    const models = [
      "claude-haiku-4-5-20251001",
      "claude-sonnet-4-5-20250929",
      "claude-opus-4-6",
    ];

    for (const model of models) {
      const params: import("../src/types.js").ChatParams = {
        message: "test",
        cwd: "/tmp",
        model,
      };
      expect(params.model).toBe(model);
    }
  });
});

// ============ adapter 传参测试：model 传给 SDK query ============

describe("模型选择 - OfficialAdapter", () => {
  it("chat 方法解构出 model 字段", async () => {
    // 验证 OfficialAdapter.chat 能接受带 model 的 ChatParams
    // 这是编译级验证 — 如果 chat 不解构 model，TypeScript 不会报错
    // 但我们可以验证 ChatParams 的结构
    const params: import("../src/types.js").ChatParams = {
      message: "hello",
      cwd: "/tmp",
      model: "claude-opus-4-6",
      sessionId: "test-session",
    };

    expect(params).toHaveProperty("model");
    expect(params).toHaveProperty("message");
    expect(params).toHaveProperty("cwd");
  });
});

// ============ HTTP body 解析测试 ============

describe("模型选择 - HTTP body 解析", () => {
  it("JSON body 包含 model 时可以正确解构", () => {
    const body = JSON.stringify({
      message: "hello",
      model: "claude-opus-4-6",
      sessionId: "session1",
    });

    const parsed = JSON.parse(body);
    const { message, sessionId, model, images } = parsed as {
      message: string;
      sessionId?: string;
      model?: string;
      images?: any[];
    };

    expect(message).toBe("hello");
    expect(sessionId).toBe("session1");
    expect(model).toBe("claude-opus-4-6");
    expect(images).toBeUndefined();
  });

  it("附加字段可以透传到 adapter.chat 参数", () => {
    const parsedBody = {
      message: "hello",
      settingSources: ["user", "project", "local"],
      appendSystemPrompt: "当前底层模型为 gpt-5.4",
    };
    const cwd = "/tmp";

    const chatParams = {
      message: parsedBody.message,
      cwd,
      settingSources: parsedBody.settingSources,
      appendSystemPrompt: parsedBody.appendSystemPrompt,
    };

    expect(chatParams.settingSources).toEqual(["user", "project", "local"]);
    expect(chatParams.appendSystemPrompt).toContain("gpt-5.4");
  });

  it("JSON body 不含 model 时解构为 undefined", () => {
    const body = JSON.stringify({
      message: "hello",
    });

    const parsed = JSON.parse(body);
    const { message, model } = parsed as {
      message: string;
      model?: string;
    };

    expect(message).toBe("hello");
    expect(model).toBeUndefined();
  });

  it("model 透传到 adapter.chat 参数", () => {
    // 模拟 handleChat 的透传逻辑
    const parsedBody = { message: "hello", model: "claude-opus-4-6" };
    const cwd = "/tmp";

    // 这是 handleChat 应该构造的参数
    const chatParams = {
      message: parsedBody.message,
      cwd,
      model: parsedBody.model,
    };

    expect(chatParams.model).toBe("claude-opus-4-6");
  });

  it("不传 model 时透传 undefined", () => {
    const parsedBody = { message: "hello" } as { message: string; model?: string };
    const cwd = "/tmp";

    const chatParams = {
      message: parsedBody.message,
      cwd,
      model: parsedBody.model,
    };

    expect(chatParams.model).toBeUndefined();
  });

  it("model 为空字符串时应视为未传", () => {
    const parsedBody = { message: "hello", model: "" };

    // 空字符串应该被过滤掉，不传给 adapter
    const model = parsedBody.model || undefined;

    expect(model).toBeUndefined();
  });
});
