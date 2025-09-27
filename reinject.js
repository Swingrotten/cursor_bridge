// 强制重新注入脚本（用于开发调试）

async function reinject() {
  try {
    console.log('🔄 发送重新注入请求...');

    const response = await fetch('http://localhost:8000/bridge/reinject', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });

    const result = await response.json();

    if (result.success) {
      console.log('✅ 重新注入成功!');
      console.log('💡 现在可以测试更新后的功能了');
    } else {
      console.error('❌ 重新注入失败:', result.error);
    }
  } catch (error) {
    console.error('❌ 请求失败:', error.message);
  }
}

reinject();