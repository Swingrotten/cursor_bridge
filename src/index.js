require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const AutoBrowser = require('./auto-browser');

const app = express();
const port = process.env.PORT || 8000;
const autoMode = process.env.AUTO_BROWSER === 'true'; // 默认关闭自动模式，避免影响手动使用

// 调试环境变量
console.log('🔧 环境变量调试:');
console.log(`   PORT: ${port}`);
console.log(`   AUTO_BROWSER: ${process.env.AUTO_BROWSER}`);
console.log(`   autoMode: ${autoMode}`);
console.log(`   DEBUG: ${process.env.DEBUG}`);
console.log('');

// 自动浏览器实例
let autoBrowser = null;

// 存储活跃的SSE连接和请求
const activeStreams = new Map();
const pendingRequests = new Map();
const browserQueue = []; // 浏览器轮询队列
let browserConnected = false;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 主页 - 显示使用说明
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>Cursor Bridge</title>
    <meta charset="utf-8">
    <style>
        body { font-family: system-ui; max-width: 800px; margin: 0 auto; padding: 20px; }
        .step { background: #f5f5f5; padding: 15px; margin: 10px 0; border-radius: 8px; }
        .code { background: #1a1a1a; color: #00ff00; padding: 15px; border-radius: 8px; font-family: monospace; white-space: pre-wrap; overflow-x: auto; }
        .important { background: #fff3cd; border: 1px solid #ffeaa7; padding: 10px; border-radius: 5px; margin: 10px 0; }
        .success { background: #d4edda; border: 1px solid #c3e6cb; padding: 10px; border-radius: 5px; margin: 10px 0; }
    </style>
</head>
<body>
    <h1>🚀 Cursor Bridge API</h1>
    <p><strong>OpenAI兼容的Cursor.com API桥接服务</strong></p>

    <div class="important">
        <h3>🤖 自动化模式</h3>
        <p>服务器启动时会自动打开浏览器并尝试注入脚本。如果遇到验证，请在打开的浏览器窗口中完成验证。</p>
        <p><strong>保持浏览器窗口打开！</strong>关闭浏览器会中断API服务。</p>
    </div>

    <h2>📋 使用步骤 (自动模式)</h2>

    <div class="step">
        <h3>步骤 1: 启动服务 (自动)</h3>
        <p>运行 <code>npm start</code>，服务器将自动:</p>
        <ul>
            <li>启动 API 服务器</li>
            <li>打开浏览器窗口</li>
            <li>导航到 Cursor.com</li>
            <li>自动注入桥接脚本</li>
        </ul>
    </div>

    <div class="step">
        <h3>步骤 2: 处理验证 (可能需要)</h3>
        <p>如果遇到人机验证或登录要求，请在自动打开的浏览器窗口中完成。</p>
        <p>验证完成后，脚本会自动继续注入过程。</p>
    </div>

    <h2>📋 手动模式 (备用)</h2>

    <div class="step">
        <h3>步骤 1: 打开 Cursor.com</h3>
        <p>在浏览器中访问 <a href="https://cursor.com/cn/learn" target="_blank">https://cursor.com/cn/learn</a></p>
        <p>确保页面正常加载，完成任何必要的登录和验证。</p>
    </div>

    <div class="step">
        <h3>步骤 2: 注入桥接脚本</h3>
        <p>按 F12 打开开发者工具，切换到 Console 标签，复制并运行以下代码：</p>
        <div class="code">// 注入 Cursor Bridge 脚本
fetch('http://localhost:${port}/injection.js')
  .then(r => r.text())
  .then(code => {
    eval(code);
    console.log('✅ Cursor Bridge 注入成功！');
  })
  .catch(e => console.error('❌ 注入失败:', e));</div>
    </div>

    <div class="step">
        <h3>步骤 3: 验证连接</h3>
        <p>注入成功后，在控制台运行以下代码验证：</p>
        <div class="code">window.cursorBridge.status()</div>
        <p>应该返回状态信息表示连接成功。</p>
    </div>

    <div class="step">
        <h3>步骤 4: 使用 API</h3>
        <p>现在可以使用标准的 OpenAI API 格式调用：</p>
        <div class="code">POST http://localhost:${port}/v1/chat/completions
Content-Type: application/json

{
  "model": "claude-sonnet-4-20250514",
  "messages": [
    {"role": "user", "content": "你好"}
  ],
  "stream": true
}</div>
    </div>

    <div class="success">
        <h3>✅ 当前服务器状态</h3>
        <p>服务器运行正常，等待浏览器连接...</p>
        <p>端口: ${port} | 时间: ${new Date().toLocaleString()}</p>
    </div>

    <h2>📚 支持的模型</h2>
    <ul>
        <li>claude-sonnet-4-20250514 (默认)</li>
        <li>claude-opus-4-1-20250805</li>
        <li>claude-opus-4-20250514</li>
        <li>gpt-5</li>
        <li>gemini-2.5-pro</li>
        <li>deepseek-v3.1</li>
    </ul>

    <h2>🔧 故障排除</h2>
    <ul>
        <li>确保浏览器已打开 cursor.com 并保持活跃</li>
        <li>检查控制台是否有错误信息</li>
        <li>确认网络连接正常</li>
        <li>重新注入脚本如果连接中断</li>
    </ul>
</body>
</html>
  `);
});

// 提供注入脚本
app.get('/injection.js', (req, res) => {
  const scriptPath = path.join(__dirname, 'browser-injection.js');
  fs.readFile(scriptPath, 'utf8', (err, data) => {
    if (err) {
      res.status(500).send('console.error("无法加载注入脚本");');
      return;
    }
    res.setHeader('Content-Type', 'application/javascript');
    res.send(data);
  });
});

// 接收浏览器事件
app.post('/bridge/event', (req, res) => {
  const { type, data } = req.body;
  console.log(`[Bridge Event] ${type}:`, data);

  // 处理不同类型的事件
  switch (type) {
    case 'injected':
      browserConnected = true;
      console.log('✅ 浏览器已连接');
      break;

    case 'meta':
      // 开始新的流 - 找到最近的等待请求
      const { rid } = data;
      let matchedRequestId = null;

      // 寻找匹配的pending request (按时间倒序查找最新的)
      for (const [requestId, requestData] of Array.from(pendingRequests.entries()).reverse()) {
        if (!activeStreams.has(requestId)) {
          matchedRequestId = requestId;
          break;
        }
      }

      if (matchedRequestId) {
        const { res: streamRes } = pendingRequests.get(matchedRequestId);
        activeStreams.set(matchedRequestId, streamRes);

        // 也为Cursor的RID建立映射
        activeStreams.set(rid, streamRes);

        console.log(`🚀 开始流式响应: ${matchedRequestId} (Cursor RID: ${rid})`);
      } else {
        console.log(`⚠️ 没有找到匹配的请求，RID: ${rid}`);
      }
      break;

    case 'delta':
      // 转发增量数据
      const { rid: deltaRid, delta } = data;
      if (activeStreams.has(deltaRid)) {
        const streamRes = activeStreams.get(deltaRid);

        // 找到对应的请求ID
        let requestId = deltaRid;
        for (const [id, _] of pendingRequests) {
          if (activeStreams.get(id) === streamRes) {
            requestId = id;
            break;
          }
        }

        try {
          streamRes.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: pendingRequests.get(requestId)?.model || 'claude-sonnet-4-20250514',
            choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
          })}\n\n`);
        } catch (error) {
          console.error('发送增量数据失败:', error);
          activeStreams.delete(deltaRid);
          if (requestId !== deltaRid) {
            activeStreams.delete(requestId);
            pendingRequests.delete(requestId);
          }
        }
      } else {
        console.log(`⚠️ 没有找到活跃流，RID: ${deltaRid}`);
      }
      break;

    case 'done':
      // 完成响应
      const { rid: doneRid } = data;
      if (activeStreams.has(doneRid)) {
        const streamRes = activeStreams.get(doneRid);

        // 找到对应的请求ID
        let requestId = doneRid;
        for (const [id, _] of pendingRequests) {
          if (activeStreams.get(id) === streamRes) {
            requestId = id;
            break;
          }
        }

        try {
          streamRes.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: pendingRequests.get(requestId)?.model || 'claude-sonnet-4-20250514',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
          })}\n\n`);
          streamRes.write('data: [DONE]\n\n');
          streamRes.end();
        } catch (error) {
          console.error('完成响应失败:', error);
        }

        // 清理所有相关的映射
        activeStreams.delete(doneRid);
        if (requestId !== doneRid) {
          activeStreams.delete(requestId);
          pendingRequests.delete(requestId);
        }

        console.log(`✅ 完成响应: ${requestId} (Cursor RID: ${doneRid})`);
      } else {
        console.log(`⚠️ 没有找到活跃流，无法完成响应，RID: ${doneRid}`);
      }
      break;

    case 'usage':
      // 使用统计 - 可以记录但不需要特殊处理
      break;
  }

  res.json({ success: true });
});

// 浏览器轮询获取待发送消息
app.get('/bridge/poll', (req, res) => {
  if (browserQueue.length > 0) {
    const task = browserQueue.shift();
    console.log(`📤 发送任务给浏览器:`, task.rid);
    res.json(task);
  } else {
    // 没有任务，等待一段时间
    setTimeout(() => {
      if (browserQueue.length > 0) {
        const task = browserQueue.shift();
        console.log(`📤 发送任务给浏览器:`, task.rid);
        res.json(task);
      } else {
        res.json({ type: 'no_task' });
      }
    }, 1000);
  }
});

// 通知浏览器发送消息
app.post('/bridge/send', (req, res) => {
  const { messages, model, rid } = req.body;

  // 这个端点被浏览器调用来实际发送消息
  console.log(`🚀 浏览器请求发送消息，rid: ${rid}, 模型: ${model}`);

  res.json({ success: true, rid });
});

// OpenAI兼容的聊天接口
app.post('/v1/chat/completions', async (req, res) => {
  const { messages, model = 'claude-sonnet-4-20250514', stream = false } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: 'messages字段是必需的且必须是数组', type: 'invalid_request_error' }
    });
  }

  if (!browserConnected) {
    return res.status(503).json({
      error: {
        message: '浏览器未连接。请先在cursor.com页面中注入桥接脚本。',
        type: 'service_unavailable',
        instructions: '访问 http://localhost:' + port + ' 查看详细说明'
      }
    });
  }

  const requestId = 'chatcmpl_' + Date.now() + '_' + Math.random().toString(16).slice(2);

  if (stream) {
    // 流式响应
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    // 存储这个请求，等待浏览器事件
    pendingRequests.set(requestId, { res, model, messages, timestamp: Date.now() });

    // 发送初始响应
    res.write(`data: ${JSON.stringify({
      id: requestId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }]
    })}\n\n`);

    // 将任务加入浏览器队列
    browserQueue.push({
      type: 'send_message',
      rid: requestId,
      messages: messages,
      model: model,
      timestamp: Date.now()
    });

    console.log(`📝 任务已加入队列: ${requestId}, 队列长度: ${browserQueue.length}`);

    // 超时检查
    setTimeout(() => {
      if (pendingRequests.has(requestId) && !activeStreams.has(requestId)) {
        console.log(`⏰ 请求超时: ${requestId}`);
        const pendingRes = pendingRequests.get(requestId).res;
        try {
          pendingRes.write(`data: ${JSON.stringify({
            id: requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [{ index: 0, delta: { content: '⚠️ 请求超时，请检查浏览器是否正常运行cursor.com页面' }, finish_reason: null }]
          })}\n\n`);
          pendingRes.write('data: [DONE]\n\n');
          pendingRes.end();
        } catch (e) {}
        pendingRequests.delete(requestId);
      }
    }, 15000); // 15秒超时

  } else {
    // 非流式响应
    res.json({
      id: requestId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: model,
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '非流式响应暂不支持，请使用stream: true' },
        finish_reason: 'stop'
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    });
  }
});

// 模型列表
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'claude-sonnet-4-20250514', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-opus-4-1-20250805', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-opus-4-20250514', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'gpt-5', object: 'model', created: 1677610602, owned_by: 'openai' },
      { id: 'gemini-2.5-pro', object: 'model', created: 1677610602, owned_by: 'google' },
      { id: 'deepseek-v3.1', object: 'model', created: 1677610602, owned_by: 'deepseek' }
    ]
  });
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeStreams: activeStreams.size,
    timestamp: new Date().toISOString()
  });
});

app.listen(port, async () => {
  console.log(`\n🚀 Cursor Bridge 启动成功!`);
  console.log(`📖 使用说明: http://localhost:${port}`);
  console.log(`🔗 API端点: http://localhost:${port}/v1/chat/completions`);
  console.log(`📋 模型列表: http://localhost:${port}/v1/models\n`);

  // 启动自动浏览器 (可通过环境变量控制)
  if (autoMode) {
    console.log(`🤖 正在启动自动浏览器...`);
    try {
      autoBrowser = new AutoBrowser({
        port,
        debug: true,
        useEdge: true,
        stealthMode: true,
        headless: process.env.HEADLESS === 'true'
      });
      await autoBrowser.start();
      console.log(`✅ 自动化设置完成！API服务已准备就绪。\n`);
    } catch (error) {
      console.log(`⚠️ 自动浏览器启动失败: ${error.message}`);
      console.log(`💡 请手动完成以下步骤:`);
      console.log(`   1. 访问 http://localhost:${port} 查看详细说明`);
      console.log(`   2. 在浏览器中打开 cursor.com 并注入脚本`);
      console.log(`   3. 使用标准 OpenAI API 格式调用\n`);
    }
  } else {
    console.log(`📖 手动模式启动，请手动完成以下步骤:`);
    console.log(`   1. 访问 http://localhost:${port} 查看详细说明`);
    console.log(`   2. 在浏览器中打开 cursor.com 并注入脚本`);
    console.log(`   3. 使用标准 OpenAI API 格式调用\n`);
  }
});

// 优雅关闭
process.on('SIGINT', async () => {
  console.log('\n🔄 正在关闭服务...');
  if (autoBrowser) {
    await autoBrowser.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🔄 正在关闭服务...');
  if (autoBrowser) {
    await autoBrowser.close();
  }
  process.exit(0);
});