#!/usr/bin/env node
/**
 * 飞书通知脚本 - 跨平台版本
 * 用法: node send.js "标题" "内容" [颜色]
 * 颜色: blue(默认), green, orange, red
 */

const [,, title, content, color = 'blue'] = process.argv;

if (!title || !content) {
  console.error('用法: node send.js "标题" "内容" [颜色]');
  process.exit(1);
}

const webhook = 'https://open.feishu.cn/open-apis/bot/v2/hook/e1f5a4be-6b7d-4d8c-a1e2-41b3285d15e1';

const card = {
  msg_type: 'interactive',
  card: {
    header: {
      title: { content: `📌 ${title}`, tag: 'plain_text' },
      template: color
    },
    elements: [
      {
        tag: 'div',
        text: { content, tag: 'lark_md' }
      },
      {
        tag: 'note',
        elements: [{ tag: 'plain_text', content: `⏰ ${new Date().toLocaleString('zh-CN')}` }]
      }
    ]
  }
};

fetch(webhook, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(card)
})
  .then(res => res.json())
  .then(data => {
    if (data.code === 0) {
      console.log('✅ 发送成功');
    } else {
      console.error('❌ 发送失败:', data.msg);
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('❌ 请求失败:', err.message);
    process.exit(1);
  });
