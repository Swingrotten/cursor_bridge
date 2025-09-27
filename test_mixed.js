// 测试混合消息：文本 + 图片
const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

async function testMixedMessage() {
  try {
    const response = await fetch('http://localhost:8000/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [
          {
            role: 'user',
            content: '先测试纯文本消息'
          },
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: '🖼️ 现在这条消息包含图片，你能看到吗？'
              },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${testImageBase64}`
                }
              }
            ]
          }
        ],
        stream: true
      })
    });

    console.log('✅ 请求发送成功');
    console.log('状态:', response.status);

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      console.log('\n📡 开始读取流式响应:');
      let fullResponse = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);

        // 提取内容
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const data = JSON.parse(line.substring(6));
              if (data.choices?.[0]?.delta?.content) {
                process.stdout.write(data.choices[0].delta.content);
                fullResponse += data.choices[0].delta.content;
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      }

      console.log('\n\n✅ 测试完成');
      console.log('完整响应长度:', fullResponse.length);
    }

  } catch (error) {
    console.error('❌ 测试失败:', error);
  }
}

console.log('🚀 开始混合消息测试...');
console.log('包含: 1条文本消息 + 1条图片消息');
testMixedMessage();