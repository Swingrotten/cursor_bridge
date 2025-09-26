# 使用官方 Node.js 运行时作为基础镜像
FROM node:18-slim

# 安装 Chrome/Chromium 所需的依赖
RUN apt-get update && apt-get install -y \
    wget \
    curl \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgconf-2-4 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxcursor1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxi6 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# 安装 Chromium
RUN apt-get update \
    && apt-get install -y chromium \
    && rm -rf /var/lib/apt/lists/*

# 创建应用目录
WORKDIR /app

# 复制 package 文件
COPY package*.json ./

# 设置 Puppeteer 配置 (跳过下载，使用系统 Chrome)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# 安装 Node.js 依赖 (美国服务器使用官方源更快)
RUN npm ci --omit=dev && \
    npm cache clean --force

# 复制应用代码
COPY . .

# 创建非 root 用户
RUN groupadd -r appuser && useradd -r -g appuser -G audio,video appuser \
    && mkdir -p /home/appuser/Downloads \
    && chown -R appuser:appuser /home/appuser \
    && chown -R appuser:appuser /app

# 切换到非 root 用户
USER appuser

# 暴露端口
EXPOSE 8200

# 设置 Puppeteer 环境变量
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# 启动命令
CMD ["npm", "run", "start:docker"]