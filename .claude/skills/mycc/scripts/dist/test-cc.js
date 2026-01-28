"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * CC SDK 独立测试
 */
const claude_code_1 = require("@anthropic-ai/claude-code");
async function test() {
    console.log("Testing CC SDK...\n");
    let messageCount = 0;
    let sessionId = "";
    try {
        for await (const msg of (0, claude_code_1.query)({
            prompt: "说一句话，10个字以内",
            options: {
                permissionMode: "bypassPermissions",
                cwd: process.cwd(),
            },
        })) {
            messageCount++;
            // 提取 session_id
            if (msg && typeof msg === "object" && "type" in msg) {
                if (msg.type === "system" && "session_id" in msg) {
                    sessionId = msg.session_id;
                    console.log(`[system] session_id: ${sessionId}`);
                }
                else if (msg.type === "assistant" && "message" in msg) {
                    const content = msg.message?.content;
                    if (Array.isArray(content)) {
                        for (const item of content) {
                            if (item.type === "text") {
                                console.log(`[assistant] ${item.text}`);
                            }
                        }
                    }
                }
                else if (msg.type === "result") {
                    console.log(`[result] 完成，共 ${messageCount} 条消息`);
                }
            }
        }
        console.log("\n✓ CC SDK 调用成功!");
    }
    catch (error) {
        console.error("\n✗ CC SDK 调用失败:", error);
        process.exit(1);
    }
}
test();
//# sourceMappingURL=test-cc.js.map