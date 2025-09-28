require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const AutoBrowser = require('./auto-browser');

const app = express();
const port = process.env.PORT || 8000;
const autoMode = process.env.AUTO_BROWSER === 'true'; // 默认关闭自动模式，避免影响手动使用

// 超时配置
const REQUEST_START_TIMEOUT = parseInt(process.env.REQUEST_START_TIMEOUT) || 15000;
const STREAM_RESPONSE_TIMEOUT = parseInt(process.env.STREAM_RESPONSE_TIMEOUT) || 30000;

// 调试环境变量（受DEBUG_ENV控制）
if (process.env.DEBUG_ENV === 'true') {
  console.log('🔧 环境变量调试:');
  console.log(`   PORT: ${port}`);
  console.log(`   AUTO_BROWSER: ${process.env.AUTO_BROWSER}`);
  console.log(`   autoMode: ${autoMode}`);
  console.log(`   HEADLESS: ${process.env.HEADLESS}`);
  console.log(`   DEBUG: ${process.env.DEBUG}`);
  console.log(`   DEBUG_ENV: ${process.env.DEBUG_ENV}`);
  console.log(`   DEBUG_BROWSER: ${process.env.DEBUG_BROWSER}`);
  console.log(`   REQUEST_START_TIMEOUT: ${REQUEST_START_TIMEOUT}ms`);
  console.log(`   STREAM_RESPONSE_TIMEOUT: ${STREAM_RESPONSE_TIMEOUT}ms`);
  console.log('');
}

// 自动浏览器实例
let autoBrowser = null;

// 存储活跃的SSE连接和请求
const activeStreams = new Map(); // requestId -> { res, lastActivity, timeouts }
const pendingRequests = new Map();
const nonStreamRequests = new Map(); // requestId -> { resolve, reject, data, startTime, model }
const browserQueue = []; // 浏览器轮询队列
let browserConnected = false;

// 流超时管理
const streamTimeouts = new Map(); // requestId -> { startTimeout, responseTimeout }

// 流清理函数
function cleanupStream(requestId, reason = '未知原因') {
  console.log(`🧹 清理流: ${requestId} (原因: ${reason})`);
  
  // 获取流响应对象
  const streamData = activeStreams.get(requestId);
  if (streamData && streamData.res) {
    try {
      // 发送最终数据并关闭流
      streamData.res.write(`data: ${JSON.stringify({
        id: requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: pendingRequests.get(requestId)?.model || 'claude-sonnet-4-20250514',
        choices: [{ index: 0, delta: { content: `\n\n⚠️ 流已超时关闭 (${reason})` }, finish_reason: 'stop' }]
      })}\n\n`);
      streamData.res.write('data: [DONE]\n\n');
      streamData.res.end();
    } catch (error) {
      console.error(`清理流失败: ${requestId}`, error);
    }
  }
  
  // 复用超时清理逻辑
  clearTimeouts(requestId);
  
  // 清理流数据
  activeStreams.delete(requestId);
  pendingRequests.delete(requestId);
  
  // 清理非流式请求（如果存在）
  if (nonStreamRequests.has(requestId)) {
    const nonStreamData = nonStreamRequests.get(requestId);
    // 先删除再reject，避免重复处理
    nonStreamRequests.delete(requestId);
    nonStreamData.reject(new Error(`请求超时: ${reason}`));
  }
  
  // 还需要根据RID清理 (查找对应的RID)
  for (const [rid, streamRes] of activeStreams.entries()) {
    if (streamRes === streamData?.res) {
      activeStreams.delete(rid);
      break;
    }
  }
}

// 设置流开始超时 - 只检查流是否能够开始
function setupStreamStartTimeout(requestId) {
  const startTimeout = setTimeout(() => {
    if (pendingRequests.has(requestId) && !activeStreams.has(requestId)) {
      cleanupStream(requestId, `初始超时 ${REQUEST_START_TIMEOUT/1000}秒内未开始响应`);
    }
  }, REQUEST_START_TIMEOUT);
  
  streamTimeouts.set(requestId, { startTimeout });
  console.log(`⏰ 已设置流开始超时: ${requestId} (${REQUEST_START_TIMEOUT/1000}s)`);
}

// 设置响应完成超时 - 在done事件后等待usage事件
function setupResponseTimeout(requestId) {
  const timeouts = streamTimeouts.get(requestId) || {};
  
  // 清理开始超时（如果还存在）
  if (timeouts.startTimeout) {
    clearTimeout(timeouts.startTimeout);
  }
  
  // 清理delta超时（done事件后不再接收delta）
  if (timeouts.deltaTimeout) {
    clearTimeout(timeouts.deltaTimeout);
  }
  
  // 设置响应超时
  const responseTimeout = setTimeout(() => {
    // 分别处理流式和非流式请求的超时
    if (nonStreamRequests.has(requestId)) {
      // 非流式请求超时：直接返回已收到的内容
      const requestData = nonStreamRequests.get(requestId);
      nonStreamRequests.delete(requestId);
      
      const response = {
        id: requestId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: requestData.model || 'claude-sonnet-4-20250514',
        choices: [{
          index: 0,
          message: { 
            role: 'assistant', 
            content: requestData.content || '' 
          },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      };
      
      requestData.resolve(response);
      console.log(`⏰ 非流式请求超时完成: ${requestId} (使用已收到内容)`);
      clearTimeouts(requestId);
    } else if (activeStreams.has(requestId)) {
      // 流式请求超时：使用原有清理逻辑
      cleanupStream(requestId, `响应超时 ${STREAM_RESPONSE_TIMEOUT/1000}秒未收到usage事件`);
    }
  }, STREAM_RESPONSE_TIMEOUT);
  
  streamTimeouts.set(requestId, { ...timeouts, startTimeout: null, deltaTimeout: null, responseTimeout });
  console.log(`⏰ 已设置响应完成超时: ${requestId} (${STREAM_RESPONSE_TIMEOUT/1000}s)`);
}

// 清理超时定时器 - 复用现有逻辑
function clearTimeouts(requestId) {
  const timeouts = streamTimeouts.get(requestId);
  if (timeouts) {
    if (timeouts.startTimeout) clearTimeout(timeouts.startTimeout);
    if (timeouts.responseTimeout) clearTimeout(timeouts.responseTimeout);
    if (timeouts.deltaTimeout) clearTimeout(timeouts.deltaTimeout);
    streamTimeouts.delete(requestId);
  }
}

// 设置或重置delta活动超时 - 检查delta事件之间的间隔
function resetDeltaTimeout(requestId) {
  const timeouts = streamTimeouts.get(requestId) || {};
  
  // 清理之前的delta超时（如果存在）
  if (timeouts.deltaTimeout) {
    clearTimeout(timeouts.deltaTimeout);
  }
  
  // 设置新的delta超时
  const deltaTimeout = setTimeout(() => {
    if (activeStreams.has(requestId)) {
      cleanupStream(requestId, `Delta超时 ${STREAM_RESPONSE_TIMEOUT/1000}秒无新的delta事件`);
    }
  }, STREAM_RESPONSE_TIMEOUT);
  
  streamTimeouts.set(requestId, { ...timeouts, deltaTimeout });
}

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
        <div class="code">// 流式输出（实时响应）
POST http://localhost:${port}/v1/chat/completions
Content-Type: application/json

{
  "model": "claude-sonnet-4-20250514",
  "messages": [
    {"role": "user", "content": "你好"}
  ],
  "stream": true
}

// 非流式输出（一次性完整响应）
POST http://localhost:${port}/v1/chat/completions
Content-Type: application/json

{
  "model": "claude-sonnet-4-20250514",
  "messages": [
    {"role": "user", "content": "你好"}
  ],
  "stream": false
}</div>
    </div>

    <div class="success">
        <h3>✅ 当前服务器状态</h3>
        <p>服务器运行正常，等待浏览器连接...</p>
        <p>端口: ${port} | 时间: ${new Date().toLocaleString()}</p>
    </div>

    <h2>🚀 功能特性</h2>
    <ul>
        <li><strong>流式输出</strong> - 实时流式响应，适合长文本生成</li>
        <li><strong>非流式输出</strong> - 一次性完整响应，适合短文本或需要原子性的场景</li>
        <li><strong>混合请求</strong> - 同时支持流式和非流式请求</li>
        <li><strong>自动超时管理</strong> - 智能处理请求超时，避免资源泄漏</li>
        <li><strong>浏览器自动化</strong> - 自动打开浏览器并注入脚本</li>
        <li><strong>OpenAI兼容</strong> - 完全兼容OpenAI API格式</li>
    </ul>

    <h2>📚 支持的模型</h2>
    <ul>
        <li><strong>Claude 系列:</strong></li>
        <li>&nbsp;&nbsp;claude-sonnet-4-20250514 (默认)</li>
        <li>&nbsp;&nbsp;claude-opus-4-1-20250805</li>
        <li>&nbsp;&nbsp;claude-opus-4-20250514</li>
        <li>&nbsp;&nbsp;claude-3.5-sonnet</li>
        <li>&nbsp;&nbsp;claude-3.5-haiku</li>
        <li>&nbsp;&nbsp;claude-3.7-sonnet</li>
        <li>&nbsp;&nbsp;claude-4-sonnet</li>
        <li>&nbsp;&nbsp;claude-4-opus</li>
        <li>&nbsp;&nbsp;claude-4.1-opus</li>
        <li><strong>GPT 系列:</strong></li>
        <li>&nbsp;&nbsp;gpt-5</li>
        <li>&nbsp;&nbsp;gpt-5-codex</li>
        <li>&nbsp;&nbsp;gpt-5-mini</li>
        <li>&nbsp;&nbsp;gpt-5-nano</li>
        <li>&nbsp;&nbsp;gpt-4.1</li>
        <li>&nbsp;&nbsp;gpt-4o</li>
        <li>&nbsp;&nbsp;o3</li>
        <li>&nbsp;&nbsp;o4-mini</li>
        <li><strong>Gemini 系列:</strong></li>
        <li>&nbsp;&nbsp;gemini-2.5-pro</li>
        <li>&nbsp;&nbsp;gemini-2.5-flash</li>
        <li><strong>DeepSeek 系列:</strong></li>
        <li>&nbsp;&nbsp;deepseek-v3.1</li>
        <li>&nbsp;&nbsp;deepseek-r1</li>
        <li><strong>其他模型:</strong></li>
        <li>&nbsp;&nbsp;kimi-k2-instruct</li>
        <li>&nbsp;&nbsp;grok-3</li>
        <li>&nbsp;&nbsp;grok-3-mini</li>
        <li>&nbsp;&nbsp;grok-4</li>
    </ul>

    <h2>🔧 故障排除</h2>
    <ul>
        <li>确保浏览器已打开 cursor.com 并保持活跃</li>
        <li>检查控制台是否有错误信息</li>
        <li>确认网络连接正常</li>
        <li>重新注入脚本如果连接中断</li>
        <li>使用 <code>npm run test:stream</code> 测试流式输出</li>
        <li>使用 <code>npm run test:non-stream</code> 测试非流式输出</li>
        <li>访问 <a href="/health" target="_blank">/health</a> 查看详细状态信息</li>
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

    // 动态替换端口号和DEBUG配置
    let modifiedScript = data.replace(
      'http://localhost:8000',
      `http://localhost:${port}`
    );
    
    // 替换DEBUG配置（受DEBUG_BROWSER环境变量控制）
    modifiedScript = modifiedScript.replace(
      'const DEBUG = true;',
      `const DEBUG = ${process.env.DEBUG_BROWSER === 'true'};`
    );

    res.setHeader('Content-Type', 'application/javascript');
    res.send(modifiedScript);
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
      // 开始新的响应 - 找到最近的等待请求
      const { rid } = data;
      let matchedRequestId = null;
      let isNonStream = false;

      // 先检查非流式请求
      for (const [requestId, requestData] of Array.from(nonStreamRequests.entries()).reverse()) {
        if (!requestData.started) {
          matchedRequestId = requestId;
          requestData.started = true;
          requestData.rid = rid;
          isNonStream = true;
          
          // 清理非流式请求的开始超时
          const timeouts = streamTimeouts.get(requestId) || {};
          if (timeouts.startTimeout) {
            clearTimeout(timeouts.startTimeout);
            console.log(`⏰ 非流式请求已开始，清理开始超时: ${requestId}`);
          }
          
          console.log(`🚀 开始非流式响应: ${matchedRequestId} (Cursor RID: ${rid})`);
          break;
        }
      }

      // 如果没找到非流式请求，则检查流式请求
      if (!matchedRequestId) {
        for (const [requestId, requestData] of Array.from(pendingRequests.entries()).reverse()) {
          if (!activeStreams.has(requestId)) {
            matchedRequestId = requestId;
            break;
          }
        }

        if (matchedRequestId) {
          const { res: streamRes, model } = pendingRequests.get(matchedRequestId);
          const currentTime = Date.now();
          
          // 存储流数据，包含最后活动时间
          activeStreams.set(matchedRequestId, { 
            res: streamRes, 
            lastActivity: currentTime,
            model: model,
            startTime: currentTime
          });

          // 也为Cursor的RID建立映射
          activeStreams.set(rid, streamRes);

           // 流已开始，清理开始超时，启动delta超时检测
           const timeouts = streamTimeouts.get(matchedRequestId) || {};
           if (timeouts.startTimeout) {
             clearTimeout(timeouts.startTimeout);
             console.log(`⏰ 流已开始，清理开始超时: ${matchedRequestId}`);
           }
           resetDeltaTimeout(matchedRequestId);

           console.log(`🚀 开始流式响应: ${matchedRequestId} (Cursor RID: ${rid})`);
        }
      }

      if (!matchedRequestId) {
        console.log(`⚠️ 没有找到匹配的请求，RID: ${rid}`);
      }
      break;

    case 'delta':
      // 转发增量数据
      const { rid: deltaRid, delta } = data;
      
      // 首先检查是否是非流式请求
      let foundNonStream = false;
      for (const [requestId, requestData] of nonStreamRequests.entries()) {
        if (requestData.rid === deltaRid) {
          // 累积内容到非流式请求
          if (!requestData.content) {
            requestData.content = '';
          }
          requestData.content += delta;
          foundNonStream = true;
          break;
        }
      }
      
      // 如果不是非流式请求，则处理流式请求
      if (!foundNonStream && activeStreams.has(deltaRid)) {
        const streamRes = activeStreams.get(deltaRid);

        // 找到对应的请求ID和流数据
        let requestId = deltaRid;
        let streamData = null;
        
        // 如果deltaRid就是requestId，直接获取流数据
        if (typeof activeStreams.get(deltaRid) === 'object' && activeStreams.get(deltaRid).res) {
          requestId = deltaRid;
          streamData = activeStreams.get(deltaRid);
        } else {
          // 否则查找匹配的请求ID
          for (const [id, data] of activeStreams.entries()) {
            if (typeof data === 'object' && data.res === streamRes) {
              requestId = id;
              streamData = data;
              break;
            }
          }
        }

        if (streamData) {
          try {
            // 更新最后活动时间
            streamData.lastActivity = Date.now();
            
            // 重置delta超时 - 每次收到delta都重置计时器
            resetDeltaTimeout(requestId);
            
            streamData.res.write(`data: ${JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: streamData.model || 'claude-sonnet-4-20250514',
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }]
            })}\n\n`);
          } catch (error) {
            console.error('发送增量数据失败:', error);
            cleanupStream(requestId, '发送数据失败');
          }
        }
      } else if (!foundNonStream) {
        console.log(`⚠️ 没有找到活跃流或非流式请求，RID: ${deltaRid}`);
      }
      break;

    case 'done':
      // done 事件表示响应内容已完成，开始等待usage事件
      const { rid: doneRid } = data;
      console.log(`📋 收到done事件，开始等待usage事件: ${doneRid}`);
      
      // 检查是否是非流式请求
      let foundNonStreamDone = false;
      for (const [requestId, requestData] of nonStreamRequests.entries()) {
        if (requestData.rid === doneRid) {
          console.log(`📋 非流式请求内容已完成: ${requestId}`);
          // 为非流式请求也设置响应完成超时，防止usage事件不到达
          setupResponseTimeout(requestId);
          foundNonStreamDone = true;
          break;
        }
      }
      
      // 如果不是非流式请求，则处理流式请求的done事件
      if (!foundNonStreamDone) {
        // 找到对应的请求ID并启动响应完成超时
        let doneRequestId = doneRid;
        for (const [id, data] of activeStreams.entries()) {
          if (typeof data === 'object' && activeStreams.get(doneRid) === data.res) {
            doneRequestId = id;
            break;
          }
        }
        
        if (activeStreams.has(doneRequestId) || activeStreams.has(doneRid)) {
          setupResponseTimeout(doneRequestId);
        }
      }
      break;

    case 'usage':
      // usage 事件表示响应真正完成
      const { rid: usageRid, usage } = data;
      
      // 首先检查非流式请求
      let foundNonStreamRequest = false;
      for (const [requestId, requestData] of nonStreamRequests.entries()) {
        if (requestData.rid === usageRid) {
          // 立即清理，避免重复处理
          nonStreamRequests.delete(requestId);
          
          try {
            // 返回完整的非流式响应
            const response = {
              id: requestId,
              object: 'chat.completion',
              created: Math.floor(Date.now() / 1000),
              model: requestData.model || 'claude-sonnet-4-20250514',
              choices: [{
                index: 0,
                message: { 
                  role: 'assistant', 
                  content: requestData.content || '' 
                },
                finish_reason: 'stop'
              }],
              usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
            };
            
            requestData.resolve(response);
            console.log(`✅ 完成非流式响应: ${requestId} (Cursor RID: ${usageRid})`);
            foundNonStreamRequest = true;
          } catch (error) {
            console.error('完成非流式响应失败:', error);
            requestData.reject(error);
          }
          
          // 复用现有的超时清理逻辑
          clearTimeouts(requestId);
          
          break;
        }
      }
      
      // 如果不是非流式请求，则处理流式请求
      if (!foundNonStreamRequest && activeStreams.has(usageRid)) {
        const streamEntry = activeStreams.get(usageRid);

        // 找到对应的请求ID
        let requestId = usageRid;
        let streamData = null;
        
        // 如果usageRid就是requestId，直接获取流数据
        if (typeof streamEntry === 'object' && streamEntry.res) {
          requestId = usageRid;
          streamData = streamEntry;
        } else {
          // 否则查找匹配的请求ID
          for (const [id, data] of activeStreams.entries()) {
            if (typeof data === 'object' && data.res === streamEntry) {
              requestId = id;
              streamData = data;
              break;
            }
          }
        }

        if (streamData) {
          try {
            // 发送最终完成消息
            streamData.res.write(`data: ${JSON.stringify({
              id: requestId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: streamData.model || 'claude-sonnet-4-20250514',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: usage || {}
            })}\n\n`);
            streamData.res.write('data: [DONE]\n\n');
            streamData.res.end();
            
            console.log(`✅ 完成流式响应: ${requestId} (Cursor RID: ${usageRid}) [usage事件触发]`);
          } catch (error) {
            console.error('完成响应失败:', error);
          }
          
          // 复用超时清理逻辑
          clearTimeouts(requestId);
          
          // 清理所有相关的映射
          activeStreams.delete(usageRid);
          if (requestId !== usageRid) {
            activeStreams.delete(requestId);
          }
          pendingRequests.delete(requestId);
        }
      } else if (!foundNonStreamRequest) {
        console.log(`⚠️ 没有找到活跃流或非流式请求，无法完成响应，RID: ${usageRid}`);
      }
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

    // 设置流开始超时 - 在这里设置，确保在流开始前生效
    setupStreamStartTimeout(requestId);

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

    // 流开始超时已在上面设置

  } else {
    // 非流式响应 - 等待完整响应周期后一次性返回
    try {
      const response = await new Promise((resolve, reject) => {
        // 存储非流式请求，等待浏览器事件
        nonStreamRequests.set(requestId, { 
          resolve, 
          reject, 
          model, 
          messages, 
          content: '', 
          startTime: Date.now(),
          started: false
        });

        // 设置非流式请求开始超时
        const startTimeout = setTimeout(() => {
          if (nonStreamRequests.has(requestId)) {
            const requestData = nonStreamRequests.get(requestId);
            if (!requestData.started) {
              nonStreamRequests.delete(requestId);
              requestData.reject(new Error(`请求开始超时: ${REQUEST_START_TIMEOUT/1000}秒内未开始响应`));
              console.log(`⏰ 非流式请求开始超时: ${requestId}`);
            }
          }
        }, REQUEST_START_TIMEOUT);
        
        streamTimeouts.set(requestId, { startTimeout });
        console.log(`⏰ 已设置非流式请求开始超时: ${requestId} (${REQUEST_START_TIMEOUT/1000}s)`);

        // 将任务加入浏览器队列
        browserQueue.push({
          type: 'send_message',
          rid: requestId,
          messages: messages,
          model: model,
          timestamp: Date.now()
        });

        console.log(`📝 非流式任务已加入队列: ${requestId}, 队列长度: ${browserQueue.length}`);
      });

      res.json(response);
    } catch (error) {
      console.error('非流式请求失败:', error);
      res.status(500).json({
        error: {
          message: error.message || '请求处理失败',
          type: 'internal_error'
        }
      });
    }
  }
});

// 模型列表
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [
      // Claude 系列
      { id: 'claude-sonnet-4-20250514', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-opus-4-1-20250805', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-opus-4-20250514', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-3.5-sonnet', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-3.5-haiku', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-3.7-sonnet', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-4-sonnet', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-4-opus', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      { id: 'claude-4.1-opus', object: 'model', created: 1677610602, owned_by: 'anthropic' },
      
      // GPT 系列
      { id: 'gpt-5', object: 'model', created: 1677610602, owned_by: 'openai' },
      { id: 'gpt-5-codex', object: 'model', created: 1677610602, owned_by: 'openai' },
      { id: 'gpt-5-mini', object: 'model', created: 1677610602, owned_by: 'openai' },
      { id: 'gpt-5-nano', object: 'model', created: 1677610602, owned_by: 'openai' },
      { id: 'gpt-4.1', object: 'model', created: 1677610602, owned_by: 'openai' },
      { id: 'gpt-4o', object: 'model', created: 1677610602, owned_by: 'openai' },
      { id: 'o3', object: 'model', created: 1677610602, owned_by: 'openai' },
      { id: 'o4-mini', object: 'model', created: 1677610602, owned_by: 'openai' },
      
      // Gemini 系列
      { id: 'gemini-2.5-pro', object: 'model', created: 1677610602, owned_by: 'google' },
      { id: 'gemini-2.5-flash', object: 'model', created: 1677610602, owned_by: 'google' },
      
      // DeepSeek 系列
      { id: 'deepseek-v3.1', object: 'model', created: 1677610602, owned_by: 'deepseek' },
      { id: 'deepseek-r1', object: 'model', created: 1677610602, owned_by: 'deepseek' },
      
      // 其他模型
      { id: 'kimi-k2-instruct', object: 'model', created: 1677610602, owned_by: 'moonshot-ai' },
      { id: 'grok-3', object: 'model', created: 1677610602, owned_by: 'xai' },
      { id: 'grok-3-mini', object: 'model', created: 1677610602, owned_by: 'xai' },
      { id: 'grok-4', object: 'model', created: 1677610602, owned_by: 'xai' }
    ]
  });
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeStreams: activeStreams.size,
    pendingRequests: pendingRequests.size,
    nonStreamRequests: nonStreamRequests.size,
    browserQueue: browserQueue.length,
    browserConnected: browserConnected,
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
        debug: process.env.DEBUG === 'true',
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