# Cursor Bridge

🚀 一键启动的 OpenAI 兼容 Cursor.com API 桥接服务

## ✨ 特性

- 🔌 **一键启动**: 运行 `npm start` 即可，自动处理浏览器和脚本注入
- 🌐 **OpenAI 兼容**: 提供标准的 `/v1/chat/completions` 接口
- 🤖 **多模型支持**: Claude Sonnet 4, Opus 4.1, GPT-5, Gemini 2.5 Pro, DeepSeek V3.1
- 📡 **流式响应**: 支持 Server-Sent Events 实时流式输出
- 🎯 **智能注入**: 自动打开浏览器并注入桥接脚本
- 🛡️ **容错处理**: 自动检测验证页面，支持手动处理后继续

## 🚀 快速开始

### 1. 安装依赖
```bash
npm install
```

### 2. 一键启动
```bash
npm start
```

就这么简单！服务器会自动：
- 启动 API 服务器 (端口 8000)
- 打开浏览器窗口
- 导航到 https://cursor.com/cn/learn
- 自动注入桥接脚本

### 3. 处理验证（如果需要）
如果遇到人机验证或需要登录，在自动打开的浏览器窗口中完成即可。

### 4. 开始使用
现在可以使用标准 OpenAI API 格式调用：

```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "claude-sonnet-4-20250514",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": true
  }'
```

## ⚙️ 配置选项

复制 `.env.example` 为 `.env` 并修改配置：

```bash
# 服务器端口
PORT=8000

# 是否启用自动浏览器 (设为 false 使用手动模式)
AUTO_BROWSER=true

# 是否启用调试日志
DEBUG=false
```

## 🔧 手动模式

如果自动模式失败，可以设置 `AUTO_BROWSER=false` 或使用手动模式：

1. 访问 http://localhost:8000 查看详细说明
2. 手动打开 https://cursor.com/cn/learn
3. 在控制台运行注入脚本

## 📚 支持的模型

- `claude-sonnet-4-20250514` (默认)
- `claude-opus-4-1-20250805`
- `claude-opus-4-20250514`
- `gpt-5`
- `gemini-2.5-pro`
- `deepseek-v3.1`

## 🔍 故障排除

- **浏览器未打开**: 检查是否安装了 Chrome/Chromium
- **注入失败**: 尝试手动模式或检查网络连接
- **验证问题**: 在自动打开的浏览器中完成验证即可
- **API 调用失败**: 确保浏览器窗口保持打开状态

## 🏗️ 架构说明

本项目采用混合架构：
- **Node.js 服务器**: 提供 OpenAI 兼容接口
- **自动浏览器**: Puppeteer 自动化浏览器操作
- **注入脚本**: 在真实浏览器环境中拦截 Cursor API
- **轮询机制**: 服务器与浏览器间的通信桥梁