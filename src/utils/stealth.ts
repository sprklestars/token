/**
 * 反检测隐身模块
 *
 * 核心原则（参考 v0-auto 项目）：
 * - 轻量隐身：只隐藏 webdriver + 清理 CDP/Playwright 痕迹
 * - 不过度伪造 Canvas/WebGL/Audio 指纹（Kasada 会检测伪造行为）
 * - 绝不伪造 Kasada token，只等待真实签发
 * - 保持 UA 与 TLS 指纹一致
 */

import type { Page, BrowserContext } from 'patchright';
import { logger } from './logger.js';

/**
 * 轻量隐身脚本 - 在页面加载前注入
 * 只做最基本的自动化痕迹清理，不做重指纹伪造
 */
export const STEALTH_INIT_SCRIPT = `
(() => {
  // 1. 隐藏 navigator.webdriver
  Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined });

  // 2. 伪造 window.chrome 外壳（Chromium 浏览器应该有这个对象）
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: () => {},
      sendMessage: () => {},
    };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = () => ({});
  }
  if (!window.chrome.csi) {
    window.chrome.csi = () => ({});
  }

  // 3. 清理 Playwright / CDP / Selenium 痕迹
  const propsToDelete = [
    '__playwright', '__pw_manual', '__pw_context',
    '__pw_page', '__pw_browser',
    '__webdriver_script_fn', '__webdriver_evaluate',
    '__selenium_evaluate', '__webdriver_unevaluate',
    '__driver_evaluate', '__fxdriver_evaluate',
    '_Selenium_IDE_Recorder',
  ];
  for (const prop of propsToDelete) {
    try { delete window[prop]; } catch { /* ignore */ }
  }

  // 清理所有 cdc_ 前缀属性 (ChromeDriver 残留)
  for (const key of Object.keys(window)) {
    if (/^(cdc_|cdc_adoQpoasnfa76pfcZLmcfl_|\\$cdc_|\\$chrome_)/.test(key)) {
      try { delete window[key]; } catch { /* ignore */ }
    }
  }

  // 4. permissions.query 补丁 — notifications 权限状态
  const originalQuery = Permissions.prototype.query;
  Permissions.prototype.query = function(desc) {
    if (desc.name === 'notifications' && Notification.permission !== 'default') {
      return Promise.resolve({ state: Notification.permission, onchange: null });
    }
    return originalQuery.call(this, desc);
  };

  // 5. 合理的 languages 和 platform
  Object.defineProperty(Navigator.prototype, 'languages', {
    get: () => ['zh-CN', 'zh', 'en-US', 'en'],
  });

  // 标记已完成
  window.__v0_stealth = { ok: true };
})();
`;

/**
 * 将隐身脚本注入到 BrowserContext，确保每个新页面都自动执行
 */
export async function injectStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(STEALTH_INIT_SCRIPT);
  logger.info('隐身脚本已注入到 BrowserContext');
}

/**
 * 等待 Kasada 反机器人脚本就绪
 * Kasada 通过 ips.js 脚本动态签发 x-kpsdk-* token
 * 我们只等待它完成，绝不伪造 token
 */
export async function waitForKasada(page: Page, timeoutMs = 25000): Promise<boolean> {
  logger.info('等待 Kasada 脚本就绪...');

  const startTime = Date.now();
  const checkInterval = 1500;

  while (Date.now() - startTime < timeoutMs) {
    const state = await page.evaluate(() => {
      // 检查 ips.js 脚本是否存在
      const scripts = document.querySelectorAll('script[src]');
      let hasIpsJs = false;
      for (const s of scripts) {
        const src = (s as HTMLScriptElement).src || '';
        if (src.includes('ips.js') || src.includes('kasada') || src.includes('kpsdk')) {
          hasIpsJs = true;
          break;
        }
      }

      // 检查 Kasada 相关 cookie
      const cookies = document.cookie;
      const hasKasadaCookie =
        cookies.includes('KP_') ||
        cookies.includes('kpsdk') ||
        cookies.includes('_abck');

      // 检查全局变量
      const hasKasadaGlobal =
        !!(window as any).KPSDK ||
        !!(window as any)._kpsdk ||
        !!(window as any).kasada;

      return { hasIpsJs, hasKasadaCookie, hasKasadaGlobal };
    });

    if (state.hasKasadaCookie || state.hasKasadaGlobal) {
      logger.success('Kasada 已就绪（cookie 已签发）');
      return true;
    }

    if (state.hasIpsJs) {
      logger.debug('Kasada ips.js 已加载，等待 cookie 签发...');
    }

    await new Promise((r) => setTimeout(r, checkInterval));
  }

  // 超时不一定是致命问题 — 有些页面可能不加载 Kasada
  logger.warn('Kasada 等待超时，继续流程（可能该页面无 Kasada 保护）');
  return false;
}

/**
 * 检测页面是否触发了硬风控
 * 返回 true 表示应该停止当前操作
 */
export async function detectHardBlock(page: Page): Promise<boolean> {
  try {
    const bodyText = await page.textContent('body');
    if (!bodyText) return false;

    const lower = bodyText.toLowerCase();
    const hardMarkers = [
      'please try again later or use a different signup method',
      'try a different sign up method',
      'your account requires further verification',
      'unknown_error',
    ];

    for (const marker of hardMarkers) {
      if (lower.includes(marker)) {
        logger.error(`检测到硬风控: "${marker}"`);
        return true;
      }
    }
  } catch {
    // ignore
  }
  return false;
}
