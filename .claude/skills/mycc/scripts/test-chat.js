const http = require('http');

async function testChat() {
  console.log('Testing chat endpoint...');

  const token = '7UMBKM'; // 从服务输出中获取
  const options = {
    hostname: 'localhost',
    port: 8080,
    path: '/chat',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    }
  };

  const req = http.request(options, (res) => {
    console.log(`Status: ${res.statusCode}`);
    console.log(`Headers: ${JSON.stringify(res.headers)}`);

    let data = '';
    res.on('data', (chunk) => {
      data += chunk;
      // 解析 SSE 格式
      const lines = data.split('\n');
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const json = JSON.parse(line.substring(6));
            console.log('Received:', json);
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
      data = lines[lines.length - 1]; // 保留未完成的行
    });

    res.on('end', () => {
      console.log('Response ended');
    });
  });

  req.on('error', (error) => {
    console.error('Request error:', error);
  });

  const body = JSON.stringify({
    message: "Hello, this is a test message from the chat test.",
    sessionId: null
  });

  req.write(body);
  req.end();
}

testChat().catch(console.error);