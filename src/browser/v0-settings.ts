/**
 * v0.app/settings/keys 页面自动化
 *
 * 利用已有的 Vercel 登录 session 来创建 v0 API Key
 * 使用人类化交互（粘贴输入、随机延迟）
 */

import type { Page } from 'patchright';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { humanPaste, humanClick, humanDwell } from '../utils/human.js';

export class V0SettingsPage {
  private page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  /** 导航到 v0 API Key 管理页面 */
  async navigateToKeys(): Promise<void> {
    logger.info('打开 v0.app/settings/keys...');

    // 先关闭可能的弹窗
    await this.dismissOverlays();

    await this.page.goto('https://v0.app/settings/keys', {
      waitUntil: 'domcontentloaded',
    });

    await sleep(3000);
    await this.dismissOverlays();
    logger.success('v0 设置页已加载');
  }

  /** 关闭登录后可能的弹窗/引导 */
  private async dismissOverlays(): Promise<void> {
    const dismissSelectors = [
      'button:has-text("Got it")',
      'button:has-text("Close")',
      'button:has-text("Dismiss")',
      'button:has-text("Skip")',
      'button:has-text("知道了")',
      '[aria-label="Close"]',
      '[aria-label="close"]',
    ];

    for (const selector of dismissSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 1000 })) {
          await el.click();
          await sleep(500);
        }
      } catch {
        // continue
      }
    }
  }

  /** 创建新的 API Key */
  async createApiKey(name: string = 'auto-register'): Promise<string> {
    logger.info(`创建 v0 API Key: ${name}`);

    // 找到创建按钮
    const createSelectors = [
      'button:has-text("Create API Key")',
      'button:has-text("Create")',
      'button:has-text("New API Key")',
      'button:has-text("Generate")',
      '[data-testid*="create"]',
    ];

    let clicked = false;
    for (const selector of createSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 3000 })) {
          await humanClick(this.page, el);
          clicked = true;
          logger.info('已点击创建按钮');
          break;
        }
      } catch {
        continue;
      }
    }

    if (!clicked) {
      throw new Error('找不到创建 API Key 按钮');
    }

    await humanDwell(1000, 2000);

    // 输入 Key 名称
    const nameInputSelectors = [
      'input[name="name"]',
      'input[placeholder*="name" i]',
      'input[placeholder*="Name" i]',
      'dialog input[type="text"]',
      '[role="dialog"] input[type="text"]',
    ];

    for (const selector of nameInputSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await humanPaste(this.page, el, name);
          logger.info(`已输入 Key 名称: ${name}`);
          break;
        }
      } catch {
        continue;
      }
    }

    await humanDwell(800, 1500);

    // 确认创建
    const confirmSelectors = [
      'button:has-text("Create API Key")',
      'button:has-text("Create")',
      'button:has-text("Generate")',
      'button[type="submit"]',
    ];

    for (const selector of confirmSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await humanClick(this.page, el);
          logger.info('已确认创建');
          break;
        }
      } catch {
        continue;
      }
    }

    await sleep(3000);

    // 提取 API Key
    const apiKey = await this.extractApiKey();
    logger.success(`v0 API Key 已创建: ${apiKey.slice(0, 30)}...`);

    // 关闭弹窗
    try {
      const doneBtn = this.page.locator('button:has-text("Done"), button:has-text("Close")').first();
      if (await doneBtn.isVisible({ timeout: 2000 })) {
        await humanClick(this.page, doneBtn);
      }
    } catch {
      // ignore
    }

    return apiKey;
  }

  /** 从页面中提取生成的 API Key */
  private async extractApiKey(): Promise<string> {
    // 从页面全文匹配 v0 key 格式
    const bodyText = await this.page.textContent('body');
    if (bodyText) {
      const patterns = [
        /(v1:team_[A-Za-z0-9]{10,80}:vcp_[A-Za-z0-9]{24,80})/,
        /(vcp_[A-Za-z0-9]{24,80})/,
        /(v0_[a-zA-Z0-9_-]{10,})/,
      ];

      for (const pattern of patterns) {
        const match = bodyText.match(pattern);
        if (match?.[1]) {
          logger.info(`从页面文本匹配到 API Key: ${match[1].slice(0, 30)}...`);
          return match[1];
        }
      }
    }

    // 从 input/textarea/code 元素中提取
    const extractSelectors = [
      'input[value*="v1:"]',
      'input[value*="vcp_"]',
      'input[value*="v0_"]',
      'code:has-text("v1:")',
      'code:has-text("vcp_")',
      'pre:has-text("v1:")',
      '[data-testid*="key"]',
      '[data-testid*="token"]',
    ];

    for (const selector of extractSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 })) {
          const text =
            (await el.getAttribute('value')) ||
            (await el.textContent());
          if (text && text.trim().length > 10) {
            logger.info(`从元素提取到 API Key: ${text.trim().slice(0, 30)}...`);
            return text.trim();
          }
        }
      } catch {
        continue;
      }
    }

    // DOM 遍历提取
    try {
      const apiKey = await this.page.evaluate(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        while (walker.nextNode()) {
          const text = walker.currentNode.textContent?.trim();
          if (text) {
            const match = text.match(
              /(v1:team_[A-Za-z0-9]{10,80}:vcp_[A-Za-z0-9]{24,80}|vcp_[A-Za-z0-9]{24,80}|v0_[a-zA-Z0-9_-]{10,})/,
            );
            if (match?.[1]) return match[1];
          }
        }
        return null;
      });

      if (apiKey) {
        logger.info(`从 DOM 文本节点提取到 API Key: ${apiKey.slice(0, 30)}...`);
        return apiKey;
      }
    } catch {
      // continue
    }

    throw new Error('无法从页面中提取 v0 API Key，页面结构可能已变化');
  }
}
