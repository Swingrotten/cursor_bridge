// 测试图片上传功能
const fs = require('fs');
const path = require('path');

// 创建一个简单的测试图片 (1x1 红色像素的 PNG)
const testImageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// OpenAI 标准的多模态消息格式
const testMessage = {
  model: 'claude-sonnet-4-20250514',
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: '🖼️ 这是一个测试图片，请告诉我你能看到什么？'
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
};

async function testImageUpload() {
  try {
    const response = await fetch('http://localhost:8000/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testMessage)
    });

    console.log('✅ 请求发送成功');
    console.log('状态:', response.status);
    console.log('响应头:', Object.fromEntries(response.headers));

    if (response.body) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      console.log('\n📡 开始读取流式响应:');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        console.log('📦 收到数据块:', chunk);
      }
    }

  } catch (error) {
    console.error('❌ 测试失败:', error);
  }
}

console.log('🚀 开始图片上传测试...');
console.log('测试图片: 1x1红色像素PNG');
console.log('Base64长度:', testImageBase64.length);
console.log('');

testImageUpload();