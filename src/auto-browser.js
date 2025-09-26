const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

class AutoBrowser {
  constructor(options = {}) {
    this.browser = null;
    this.page = null;
    this.isInjected = false;
    this.options = {
      headless: options.headless || process.env.HEADLESS === 'true', // 支持环境变量控制
      debug: options.debug || process.env.DEBUG === 'true',
      port: options.port || process.env.PORT || 8000,
      browser: options.browser || process.env.BROWSER || 'auto', // 浏览器选择
      stealthMode: options.stealthMode !== false, // 默认启用隐身模式
      ...options
    };
  }

  log(...args) {
    if (this.options.debug) {
      console.log('[AutoBrowser]', ...args);
    }
  }

  findBrowserPath() {
    const fs = require('fs');
    const path = require('path');

    // 定义所有浏览器路径
    const allBrowsers = {
      edge: {
        name: 'Microsoft Edge',
        paths: [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe'
        ]
      },
      chrome: {
        name: 'Google Chrome',
        paths: [
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'
        ]
      },
      chromium: {
        name: 'Chromium',
        paths: [
          'C:\\Program Files (x86)\\Chromium\\Application\\chrome.exe',
          'C:\\Program Files\\Chromium\\Application\\chrome.exe',
          'C:\\Users\\' + process.env.USERNAME + '\\AppData\\Local\\Chromium\\Application\\chrome.exe'
        ]
      }
    };

    const preferredBrowser = this.options.browser.toLowerCase();

    // 如果指定了特定浏览器，优先查找该浏览器
    if (preferredBrowser !== 'auto' && allBrowsers[preferredBrowser]) {
      const browser = allBrowsers[preferredBrowser];
      for (const browserPath of browser.paths) {
        if (fs.existsSync(browserPath)) {
          return { name: browser.name, path: browserPath };
        }
      }
      this.log(`⚠️ 指定的浏览器 ${preferredBrowser} 未找到，回退到自动检测`);
    }

    // 自动检测模式：按优先级 Edge > Chrome > Chromium
    const browserPriority = ['edge', 'chrome', 'chromium'];
    for (const browserKey of browserPriority) {
      const browser = allBrowsers[browserKey];
      for (const browserPath of browser.paths) {
        if (fs.existsSync(browserPath)) {
          return { name: browser.name, path: browserPath };
        }
      }
    }

    return null;
  }

  async start() {
    try {
      await this.launchBrowser();
      await this.navigateAndInject();
      await this.waitForInjection();
      return true;
    } catch (error) {
      this.log('自动浏览器启动失败:', error.message);
      throw error;
    }
  }

  async launchBrowser() {
    this.log('启动浏览器...');

    // 查找可用的浏览器路径
    const browserInfo = this.findBrowserPath();

    const launchOptions = {
      headless: this.options.headless ? "new" : false,
      defaultViewport: this.options.headless ? { width: 1920, height: 1080 } : null,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-features=VizDisplayCompositor',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-networking',
        '--disable-ipc-flooding-protection',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
      ]
    };

    // 只在非无头模式下最大化窗口
    if (!this.options.headless) {
      launchOptions.args.push('--start-maximized');
    }

    // 如果找到浏览器，使用找到的浏览器
    if (browserInfo) {
      launchOptions.executablePath = browserInfo.path;
      this.log(`使用 ${browserInfo.name} 浏览器 (${this.options.headless ? '无头模式' : '可视模式'}):`, browserInfo.path);
    } else {
      this.log(`使用默认 Chrome 浏览器 (${this.options.headless ? '无头模式' : '可视模式'})`);
    }

    this.browser = await puppeteer.launch(launchOptions);

    const pages = await this.browser.pages();
    this.page = pages[0] || await this.browser.newPage();

    // 设置合理的User Agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0'
    );

    // 添加反检测脚本
    await this.page.evaluateOnNewDocument(() => {
      // 删除 webdriver 属性
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });

      // 伪装 plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          {
            0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format", enabledPlugin: null },
            description: "Portable Document Format",
            filename: "internal-pdf-viewer",
            length: 1,
            name: "Chrome PDF Plugin"
          },
          {
            0: { type: "application/pdf", suffixes: "pdf", description: "", enabledPlugin: null },
            description: "",
            filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
            length: 1,
            name: "Chrome PDF Viewer"
          }
        ]
      });

      // 伪装 languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en', 'zh-CN', 'zh']
      });

      // 删除自动化相关属性
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Array;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Promise;
      delete window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol;
    });

    this.log('浏览器启动成功');
  }

  async navigateAndInject() {
    this.log('导航到 Cursor.com...');

    try {
      await this.page.goto('https://cursor.com/cn/learn', {
        waitUntil: 'networkidle2',
        timeout: 45000
      });

      this.log('页面加载完成，模拟用户行为...');

      // 模拟更真实的用户行为
      await this.page.waitForTimeout(3000);

      // 随机滚动页面
      await this.page.evaluate(() => {
        window.scrollBy(0, Math.random() * 500);
      });

      await this.page.waitForTimeout(2000);

      // 移动鼠标
      await this.page.mouse.move(Math.random() * 800, Math.random() * 600);
      await this.page.waitForTimeout(1000);

      // 检查页面状态
      const pageInfo = await this.page.evaluate(() => ({
        title: document.title,
        url: window.location.href,
        hasAuth: document.querySelector('.cf-browser-verification') !== null ||
                document.title.includes('验证') ||
                document.title.includes('Verification'),
        bodyText: document.body.innerText.substring(0, 200)
      }));

      this.log('页面信息:', {
        title: pageInfo.title,
        url: pageInfo.url,
        hasAuth: pageInfo.hasAuth
      });

      if (pageInfo.hasAuth) {
        this.log('⚠️ 检测到验证页面，请在浏览器中完成验证后继续...');
        this.log('等待验证完成，10秒后重试...');
        await this.page.waitForTimeout(10000);

        // 重新检查是否已通过验证
        await this.page.reload({ waitUntil: 'networkidle2' });
      }

      // 执行注入
      await this.performInjection();

    } catch (error) {
      this.log('导航或注入过程出错:', error.message);

      if (!this.options.headless) {
        this.log('浏览器保持打开状态，您可以手动处理...');
        this.log('处理完成后，脚本将自动检测注入状态');

        // 每5秒检查一次注入状态
        await this.waitForManualInjection();
      } else {
        // 无头模式下直接抛出错误
        this.log('⚠️ 无头模式下自动注入失败，可能需要手动处理验证');
        this.log('建议：切换到可视模式 (HEADLESS=false) 进行首次设置');
        throw error;
      }
    }
  }

  async performInjection() {
    this.log('开始自动注入脚本...');

    // 读取注入脚本
    const injectionPath = path.join(__dirname, 'browser-injection.js');
    let injectionScript = fs.readFileSync(injectionPath, 'utf8');

    // 动态替换端口号
    injectionScript = injectionScript.replace(
      'http://localhost:8000',
      `http://localhost:${this.options.port}`
    );

    try {
      // 执行注入
      await this.page.evaluate((script) => {
        // 创建script标签并执行
        const scriptElement = document.createElement('script');
        scriptElement.textContent = script;
        document.head.appendChild(scriptElement);

        // 立即移除script标签避免检测
        document.head.removeChild(scriptElement);
      }, injectionScript);

      this.log('✅ 脚本注入成功！');

      // 等待一下让脚本初始化
      await this.page.waitForTimeout(2000);

      // 验证注入是否成功
      const injectionStatus = await this.page.evaluate(() => {
        return {
          injected: !!window.__cursorBridgeInjected,
          hasApi: !!window.cursorBridge,
          status: window.cursorBridge ? window.cursorBridge.status() : null
        };
      });

      if (injectionStatus.injected) {
        this.isInjected = true;
        this.log('✅ 注入验证成功:', injectionStatus.status);
      } else {
        throw new Error('注入验证失败');
      }

    } catch (error) {
      this.log('❌ 自动注入失败:', error.message);
      this.log('切换到手动注入模式...');
      await this.showManualInstructions();
    }
  }

  async showManualInstructions() {
    this.log('='.repeat(60));
    this.log('🔧 手动注入说明:');
    this.log('');
    this.log('自动注入失败，可能的原因:');
    this.log('1. 页面出现了人机验证 (请完成验证)');
    this.log('2. 需要登录 Cursor 账户 (请登录)');
    this.log('3. 网络连接问题 (请检查网络)');
    this.log('');
    this.log('解决方案:');
    this.log('1. 在当前浏览器窗口完成验证/登录');
    this.log('2. 按 F12 打开开发者工具');
    this.log('3. 切换到 Console 标签');
    this.log('4. 复制粘贴以下代码并按回车:');
    this.log('='.repeat(60));

    const injectionCode = `
// 注入 Cursor Bridge 脚本
fetch('http://localhost:${this.options.port}/injection.js')
  .then(r => r.text())
  .then(code => {
    eval(code);
    console.log('✅ Cursor Bridge 注入成功！');
  })
  .catch(e => console.error('❌ 注入失败:', e));
`;

    console.log(injectionCode);
    this.log('='.repeat(60));
    this.log('💡 小贴士:');
    this.log('- 确保在 https://cursor.com/cn/learn 页面执行');
    this.log('- 如果仍然失败，尝试刷新页面后重新注入');
    this.log('- 保持此浏览器窗口打开，直到使用完成');
    this.log('');
    this.log('⏳ 等待注入完成...');

    await this.waitForManualInjection();
  }

  async waitForManualInjection() {
    this.log('等待注入完成...');

    // 每5秒检查一次注入状态
    while (!this.isInjected) {
      try {
        const injectionStatus = await this.page.evaluate(() => {
          return {
            injected: !!window.__cursorBridgeInjected,
            hasApi: !!window.cursorBridge,
            status: window.cursorBridge ? window.cursorBridge.status() : null
          };
        });

        if (injectionStatus.injected) {
          this.isInjected = true;
          this.log('✅ 检测到注入成功:', injectionStatus.status);
          break;
        }
      } catch (error) {
        // 页面可能在重新加载，忽略错误继续检查
      }

      await this.page.waitForTimeout(5000);
    }
  }

  async waitForInjection() {
    if (!this.isInjected) {
      this.log('等待注入完成...');

      // 最多等待60秒
      let attempts = 0;
      const maxAttempts = 12;

      while (!this.isInjected && attempts < maxAttempts) {
        await this.page.waitForTimeout(5000);
        attempts++;

        try {
          const status = await this.page.evaluate(() => {
            return window.__cursorBridgeInjected && window.cursorBridge;
          });

          if (status) {
            this.isInjected = true;
            break;
          }
        } catch (error) {
          // 继续等待
        }
      }

      if (!this.isInjected) {
        throw new Error('注入超时，请检查浏览器状态');
      }
    }

    this.log('🎉 浏览器自动化设置完成！');
    this.log('💡 保持浏览器窗口打开，现在可以使用API了');
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.log('浏览器已关闭');
    }
  }

  // 检查注入状态
  async checkInjectionStatus() {
    if (!this.page) return false;

    try {
      const status = await this.page.evaluate(() => {
        return {
          injected: !!window.__cursorBridgeInjected,
          connected: window.cursorBridge ? !!window.cursorBridge.status() : false
        };
      });

      return status.injected && status.connected;
    } catch (error) {
      return false;
    }
  }
}

module.exports = AutoBrowser;