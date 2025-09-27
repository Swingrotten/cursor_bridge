// 测试简单文本消息
async function testSimpleMessage() {
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
            content: '你好，请回复一个简单的问候'
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
        console.log('📦 收到数据块:', chunk.substring(0, 200) + (chunk.length > 200 ? '...' : ''));

        // 尝试解析并提取内容
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const data = JSON.parse(line.substring(6));
              if (data.choices?.[0]?.delta?.content) {
                fullResponse += data.choices[0].delta.content;
              }
            } catch (e) {
              // 忽略解析错误
            }
          }
        }
      }

      console.log('\n✅ 完整响应:', fullResponse);
    }

  } catch (error) {
    console.error('❌ 测试失败:', error);
  }
}

console.log('🚀 开始简单文本测试...');
testSimpleMessage();