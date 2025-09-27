// Cursor Bridge 浏览器注入脚本
// 这个脚本需要在用户的真实浏览器中运行

(function() {
  'use strict';

  const BRIDGE_SERVER = 'http://localhost:8000';
  const DEBUG = true;

  // 避免重复注入
  if (window.__cursorBridgeInjected) {
    console.log('[Cursor Bridge] 已经注入过了');
    return;
  }

  // 标记已注入
  window.__cursorBridgeInjected = true;

  console.log('[Cursor Bridge] 开始注入...');

  // 1. 保存原始fetch
  const prevFetch = window.fetch.bind(window);
  let ridSeq = 0;
  const ridPrefix = 'RID_' + Math.random().toString(16).slice(2) + '_';

  // 2. 完全按照原脚本的结构重建核心函数
  function readText(msg) {
    if (!msg) return '';
    if (typeof msg.content === 'string') return msg.content;
    if (Array.isArray(msg.parts)) return msg.parts.find(p => p?.type === 'text')?.text ?? '';
    return '';
  }

  function toCursorMessages(listOpenAI) {
    console.log('[Cursor Bridge] 🔄 转换函数被调用，输入:', listOpenAI);

    const result = (listOpenAI || []).map(m => {
      const message = { role: m.role, parts: [] };

      if (DEBUG && Array.isArray(m.content)) {
        console.log('[Cursor Bridge] 处理多模态消息:', m.content);
      }

      // 处理不同的 content 格式
      if (typeof m.content === 'string') {
        // 简单文本消息
        message.parts.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        // OpenAI 多模态消息格式
        m.content.forEach(part => {
          if (part.type === 'text') {
            message.parts.push({ type: 'text', text: part.text || '' });
          } else if (part.type === 'image_url') {
            // OpenAI 图片格式转换为 Cursor 格式
            const imageUrl = part.image_url.url;
            if (imageUrl.startsWith('data:image/')) {
              // base64 图片
              const [header, data] = imageUrl.split(',');
              const mediaType = header.match(/data:(image\/[^;]+)/)?.[1] || 'image/jpeg';

              if (DEBUG) {
                console.log('[Cursor Bridge] 添加图片:', { mediaType, dataLength: data?.length });
              }

              message.parts.push({
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType,
                  data: data
                }
              });
            } else {
              // URL 图片 - 转为文本描述 (Cursor 可能不支持外部 URL)
              message.parts.push({
                type: 'text',
                text: `[图片URL: ${imageUrl}]`
              });
            }
          }
        });
      } else {
        // 兜底：转为文本
        message.parts.push({ type: 'text', text: String(m.content ?? '') });
      }

      return message;
    });

    console.log('[Cursor Bridge] 🔄 转换函数结果:', result);
    return result;
  }

  function buildCursorBody({ messagesOpenAI, model, rid }) {
    return {
      context: [],
      model: model || 'claude-sonnet-4-20250514',
      id: rid || ('req_' + Math.random().toString(16).slice(2)),
      messages: toCursorMessages(messagesOpenAI),
      trigger: 'submit-message',
      __mergedUpstream: true,
      __rid: rid,
    };
  }

  async function readBodyAsText(input, init) {
    if (input && typeof input === 'object' && input instanceof Request) {
      try { return await input.clone().text(); } catch { return null; }
    }
    const body = init && init.body;
    if (body == null) return null;
    if (typeof body === 'string') return body;
    if (body instanceof Blob) { try { return await body.text(); } catch { return null; } }
    if (body instanceof URLSearchParams) return body.toString();
    if (body instanceof FormData) return null;
    if (body instanceof ArrayBuffer) { try { return new TextDecoder().decode(body); } catch { return null; } }
    if (ArrayBuffer.isView(body)) { try { return new TextDecoder().decode(body.buffer); } catch { return null; } }
    return null;
  }

  function rebuildArgsWithBody(input, init, jsonStr) {
    const headers = new Headers((input && input.headers) || (init && init.headers) || {});
    headers.set('content-type', 'application/json; charset=utf-8');

    if (input instanceof Request) {
      const url = input.url;
      const reqInit = {
        method: (init && init.method) || input.method || 'POST',
        headers, body: jsonStr,
        mode: input.mode, credentials: input.credentials, cache: input.cache,
        redirect: input.redirect, referrer: input.referrer, referrerPolicy: input.referrerPolicy,
        integrity: input.integrity, keepalive: input.keepalive, signal: (init && init.signal) || input.signal,
      };
      return [new Request(url, reqInit), undefined];
    } else {
      const newInit = Object.assign({}, init, { headers, body: jsonStr, method: (init && init.method) || 'POST' });
      return [input, newInit];
    }
  }

  // 3. 流式响应处理
  const bridge = { listeners: new Set(), order: [] };

  window.emitMeta = (meta) => {
    const rid = meta?.rid;
    if (!rid) return;
    console.log('[Cursor Bridge] 收到元数据，rid=', rid);

    // 通知桥接服务器
    notifyBridgeServer('meta', { rid });
  };

  window.emitDelta = (rid, delta) => {
    console.log('[Cursor Bridge] 收到增量数据，rid=', rid, 'delta=', delta?.substring(0, 50));
    notifyBridgeServer('delta', { rid, delta });
  };

  window.emitDone = (rid) => {
    console.log('[Cursor Bridge] 完成，rid=', rid);
    notifyBridgeServer('done', { rid });
  };

  window.emitUsage = (rid, usage) => {
    console.log('[Cursor Bridge] 使用统计，rid=', rid, 'usage=', usage);
    notifyBridgeServer('usage', { rid, usage });
  };

  // 4. 与桥接服务器通信
  async function notifyBridgeServer(type, data) {
    try {
      await fetch(`${BRIDGE_SERVER}/bridge/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, data, timestamp: Date.now() })
      });
    } catch (error) {
      if (DEBUG) console.error('[Cursor Bridge] 通知服务器失败:', error);
    }
  }

  // 5. 核心fetch拦截器 - 完全按照原脚本实现
  window.fetch = async function(...args) {
    let [input, init = {}] = args;
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = (init?.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
    const isChat = url.includes('/api/chat') && method === 'POST';

    let knownRid = null;

    if (isChat) {
      try {
        const raw = await readBodyAsText(input, init);
        if (raw) {
          let body;
          try { body = JSON.parse(raw); } catch {}
          if (body && typeof body === 'object') {
            // 检查消息格式：如果已经是Cursor格式(有parts)，直接使用；否则转换
            const current = Array.isArray(body.messages) ? body.messages : [];
            let msgsOpenAI;

            // 如果消息已经有parts结构，说明是我们构建的Cursor格式，转为OpenAI格式但保留多模态内容
            if (current.length > 0 && current[0].parts) {
              console.log('[Cursor Bridge] 🔍 检测到Cursor格式消息，开始转换:', current);
              msgsOpenAI = current.map(m => {
                if (!m.parts || !Array.isArray(m.parts)) {
                  return { role: m.role, content: '' };
                }

                // 处理多模态parts
                if (m.parts.length === 1 && m.parts[0].type === 'text') {
                  // 纯文本消息
                  return { role: m.role, content: m.parts[0].text || '' };
                } else {
                  // 多模态消息，转换为OpenAI格式
                  const content = [];
                  m.parts.forEach(part => {
                    if (part.type === 'text') {
                      content.push({ type: 'text', text: part.text || '' });
                    } else if (part.type === 'image' && part.source) {
                      content.push({
                        type: 'image_url',
                        image_url: {
                          url: `data:${part.source.media_type};base64,${part.source.data}`
                        }
                      });
                    }
                  });
                  // 对于多模态消息，保持数组格式
                  if (content.length === 1 && content[0].type === 'text') {
                    return { role: m.role, content: content[0].text || '' };
                  } else {
                    return { role: m.role, content: content };
                  }
                }
              });
            } else {
              // 原始的OpenAI格式，用readText处理
              console.log('[Cursor Bridge] 🔍 检测到OpenAI格式消息，使用readText处理:', current);
              msgsOpenAI = current.map(m => ({ role: m.role, content: readText(m) }));
            }

            console.log('[Cursor Bridge] 🔍 最终转换结果:', msgsOpenAI);

            // 检查是否有上游消息覆盖
            if (window.__upstreamMessages && Array.isArray(window.__upstreamMessages)) {
              console.log('[Cursor Bridge] 使用上游消息覆盖:', window.__upstreamMessages.length, '条消息');
              msgsOpenAI = window.__upstreamMessages.map(m => ({ role: m.role, content: readText(m) }));
            }

            // 生成RID
            const rid = body.__rid || (ridPrefix + (++ridSeq));
            knownRid = rid;

            // 通知元数据
            try { window.emitMeta && window.emitMeta({ rid }); } catch {}

            // 获取模型
            const modelName = body.model || 'claude-sonnet-4-20250514';

            // 构造Cursor格式请求体
            const cursorBody = buildCursorBody({ messagesOpenAI: msgsOpenAI, model: modelName, rid });

            // 重写请求
            const jsonStr = JSON.stringify(cursorBody);
            [input, init] = rebuildArgsWithBody(input, init, jsonStr);

            console.log('[Cursor Bridge] 重写API请求:', { rid, model: modelName, messageCount: msgsOpenAI.length });

            // 通知桥接服务器开始新请求
            notifyBridgeServer('request', { rid, model: modelName, messages: msgsOpenAI });
          }
        }
      } catch (e) {
        console.error('[Cursor Bridge] 请求重写失败:', e);
      }
    }

    // 发送请求
    const resp = await prevFetch(input, init);

    // 处理响应流
    if (isChat && knownRid) {
      try {
        const clone = resp.clone();
        if (clone.body) {
          (async () => {
            const reader = clone.body.getReader();
            const decoder = new TextDecoder();
            let buf = '';

            const flush = async (chunk) => {
              const dataLines = chunk.split(/\r?\n/).filter(l => l.startsWith('data:'));
              const dataStr = dataLines.map(l => l.replace(/^data:\s?/, '')).join('\n').trim();
              if (!dataStr) return;
              if (dataStr === '[DONE]') {
                if (knownRid) window.emitDone(knownRid);
                return;
              }
              let evt;
              try { evt = JSON.parse(dataStr); } catch { return; }

              if (evt?.type === 'text-delta' && typeof evt.delta === 'string') {
                if (knownRid) window.emitDelta(knownRid, evt.delta);
              }
              const u = evt?.messageMetadata?.usage;
              if (u && knownRid) window.emitUsage(knownRid, u);
              if (evt?.type === 'text-end' || evt?.type === 'finish-step' || evt?.type === 'finish') {
                if (knownRid) window.emitDone(knownRid);
              }
            };

            while (true) {
              const { value, done } = await reader.read();
              if (done) {
                if (knownRid) window.emitDone(knownRid);
                break;
              }
              buf += decoder.decode(value, { stream: true });
              let idx;
              while ((idx = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                await flush(frame);
              }
            }
          })();
        }
      } catch (e) {
        console.error('[Cursor Bridge] SSE解析失败:', e);
      }
    }

    return resp;
  };

  // 6. 暴露桥接API
  window.cursorBridge = {
    // 发送消息
    sendMessage: async function(messages, model = 'claude-sonnet-4-20250514') {
      // 设置上游消息
      window.__upstreamMessages = messages;

      // 构建请求体
      const rid = ridPrefix + (++ridSeq);
      const body = {
        context: [],
        model: model,
        id: 'req_' + Math.random().toString(16).slice(2),
        messages: toCursorMessages(messages), // 使用我们的转换函数
        trigger: 'submit-message',
        __rid: rid
      };

      console.log('[Cursor Bridge] 发送消息:', { model, messageCount: messages.length });

      if (DEBUG) {
        console.log('[Cursor Bridge] 原始消息:', messages);
        console.log('[Cursor Bridge] 转换后消息:', body.messages);
      }

      // 直接调用API
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });

      return response;
    },

    // 检查状态
    status: function() {
      return {
        injected: true,
        version: '1.0.0',
        server: BRIDGE_SERVER,
        timestamp: new Date().toISOString()
      };
    }
  };

  // 7. 启动轮询机制
  async function startPolling() {
    while (true) {
      try {
        const response = await fetch(`${BRIDGE_SERVER}/bridge/poll`);
        const task = await response.json();

        if (task.type === 'send_message') {
          console.log('[Cursor Bridge] 收到发送消息任务:', task.rid);

          // 设置上游消息并发送
          window.__upstreamMessages = task.messages;

          const response = await window.cursorBridge.sendMessage(task.messages, task.model);
          console.log('[Cursor Bridge] 消息发送完成:', task.rid);
        }

        // 等待一秒再轮询
        await new Promise(resolve => setTimeout(resolve, 1000));

      } catch (error) {
        if (DEBUG) console.error('[Cursor Bridge] 轮询失败:', error);
        // 错误时等待3秒再重试
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
  }

  console.log('[Cursor Bridge] 注入完成！');
  console.log('[Cursor Bridge] 状态:', window.cursorBridge.status());

  // 通知桥接服务器注入完成
  notifyBridgeServer('injected', { timestamp: Date.now() });

  // 启动轮询
  startPolling();

})();