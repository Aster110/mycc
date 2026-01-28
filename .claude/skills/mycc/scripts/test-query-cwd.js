const { query } = require('@anthropic-ai/claude-code');
const path = require('path');
const fs = require('fs');

async function test() {
  console.log('Testing CC SDK query function with project root cwd...');

  // 使用项目根目录作为 cwd（来自 current.json）
  const projectRoot = path.join(__dirname, '..', '..', '..'); // C:\Users\pc\mycc
  console.log(`Project root: "${projectRoot}"`);

  // 模拟 cc-bridge.ts 中的逻辑
  const isWindows = process.platform === "win32";
  let finalExecutable = "claude";
  let finalCliPath = "claude";

  if (isWindows) {
    try {
      const { execSync } = require('child_process');
      const result = execSync("where claude", { encoding: "utf-8" });
      const lines = result.split(/\r?\n/).filter(line => line.trim());
      let selectedPath = lines[0]?.trim();
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.toLowerCase().endsWith('.cmd')) {
          selectedPath = trimmed;
          break;
        }
      }
      if (selectedPath) {
        console.log(`Found claude path: "${selectedPath}"`);
        const normalizedCliPath = selectedPath.replace(/\\/g, '/');
        if (normalizedCliPath.toLowerCase().endsWith('.cmd')) {
          const cmdDir = path.dirname(normalizedCliPath);
          const cliJsPath = path.join(cmdDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
          console.log(`Checking cli.js path: "${cliJsPath}"`);
          if (fs.existsSync(cliJsPath)) {
            console.log(`Using node + cli.js`);
            finalExecutable = "node";
            finalCliPath = cliJsPath;
          } else {
            console.log(`cli.js not found, using .cmd file`);
            finalCliPath = normalizedCliPath;
          }
        } else {
          finalCliPath = normalizedCliPath;
        }
      }
    } catch (error) {
      console.error('Error detecting claude path:', error);
    }
  }

  console.log(`finalExecutable: "${finalExecutable}"`);
  console.log(`finalCliPath: "${finalCliPath}"`);

  try {
    const options = {
      prompt: "Hello from project root!",
      options: {
        executable: finalExecutable,
        pathToClaudeCodeExecutable: finalCliPath,
        cwd: projectRoot,
        permissionMode: "bypassPermissions",
      },
    };
    console.log('Calling query with options:', JSON.stringify(options, null, 2));

    for await (const message of query(options)) {
      console.log('Received message type:', message?.type);
      if (message && typeof message === 'object' && 'type' in message) {
        if (message.type === 'system' && 'session_id' in message) {
          console.log('Session ID:', message.session_id);
        }
      }
    }
    console.log('Query completed successfully');
  } catch (error) {
    console.error('Error in query:', error);
    console.error('Error stack:', error.stack);
    // 检查是否是 spawn EINVAL
    if (error.message.includes('spawn EINVAL') || (error.code === 'EINVAL')) {
      console.error('Got spawn EINVAL error!');
    }
  }
}

test().catch(console.error);