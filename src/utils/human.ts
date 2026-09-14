/**
 * 人类行为模拟模块
 *
 * 参考 v0-auto 项目的人类化策略：
 * - 粘贴模式输入（Ctrl+V 模拟）
 * - 贝塞尔曲线鼠标移动
 * - 随机延迟 + 偶尔打错字退格
 * - 元素内随机点击位置
 * - 操作间停顿
 */

import type { Page, Locator } from 'patchright';
import { logger } from './logger.js';

// ─── 随机工具 ───

function rand(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

function randInt(min: number, max: number): number {
  return Math.floor(rand(min, max + 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── 人类化输入 ───

/**
 * 粘贴模式输入（最接近真人行为）
 * 使用 fill() 确保可靠填入，前后加入人类节奏
 */
export async function humanPaste(
  page: Page,
  locator: Locator,
  text: string,
): Promise<void> {
  await locator.click();
  await sleep(randInt(100, 300));

  // 清空输入框
  await page.keyboard.press('Control+a');
  await sleep(randInt(50, 100));
  await page.keyboard.press('Backspace');
  await sleep(randInt(100, 200));

  // 用 fill 可靠填入（剪贴板 API 在自动化浏览器中不可靠）
  await locator.fill(text);
  logger.debug(`填入: ${text.slice(0, 20)}...`);

  await sleep(randInt(200, 500));
}

/**
 * 逐字输入模式（带随机延迟和打错字）
 * 每字 55-160ms，3% 概率打错字再退格，8% 概率额外停顿
 */
export async function humanType(
  page: Page,
  locator: Locator,
  text: string,
): Promise<void> {
  await locator.click();
  await sleep(randInt(100, 300));

  // 清空
  await page.keyboard.press('Control+a');
  await sleep(randInt(50, 100));
  await page.keyboard.press('Backspace');
  await sleep(randInt(100, 200));

  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';

  for (const ch of text) {
    // 3% 概率打错字再退格
    if (Math.random() < 0.03) {
      const wrongChar = chars[randInt(0, chars.length - 1)];
      await page.keyboard.press(wrongChar);
      await sleep(randInt(80, 200));
      await page.keyboard.press('Backspace');
      await sleep(randInt(100, 250));
    }

    // 正常输入
    await page.keyboard.press(ch);
    await sleep(randInt(55, 160));

    // 8% 概率额外停顿（模拟思考）
    if (Math.random() < 0.08) {
      await sleep(randInt(120, 350));
    }
  }

  await sleep(randInt(200, 500));
}

/**
 * OTP 验证码输入 — 快速逐字输入（验证码不需要慢速）
 */
export async function humanTypeOtp(
  page: Page,
  locator: Locator,
  code: string,
): Promise<void> {
  await locator.click();
  await sleep(randInt(100, 200));

  // 逐字快速输入
  for (const ch of code) {
    await page.keyboard.press(ch);
    await sleep(randInt(80, 180));
  }

  await sleep(randInt(300, 600));
}

// ─── 人类化点击 ───

/**
 * 人类化点击 — 元素内随机位置 + 按压时间模拟
 */
export async function humanClick(
  page: Page,
  locator: Locator,
): Promise<void> {
  // 获取元素边界框
  const box = await locator.boundingBox();
  if (!box) {
    // 回退到普通点击
    await locator.click();
    return;
  }

  // 元素内随机位置（不点正中心）
  const rx = rand(0.28, 0.72);
  const ry = rand(0.32, 0.72);
  const x = box.x + box.width * rx;
  const y = box.y + box.height * ry;

  // 先移动鼠标到附近
  await page.mouse.move(x + rand(-5, 5), y + rand(-5, 5));
  await sleep(randInt(50, 150));

  // 精确移动到目标
  await page.mouse.move(x, y);
  await sleep(randInt(20, 60));

  // 按下 + 随机按压时间 + 释放
  await page.mouse.down();
  await sleep(randInt(40, 120));
  await page.mouse.up();

  await sleep(randInt(100, 300));
}

// ─── 鼠标闲逛 ───

/**
 * 随机鼠标移动 — 模拟真人浏览页面的行为
 */
export async function humanMouseWander(
  page: Page,
  moves: number = 5,
): Promise<void> {
  const viewport = page.viewportSize() || { width: 1280, height: 800 };

  for (let i = 0; i < moves; i++) {
    const x = randInt(100, viewport.width - 100);
    const y = randInt(100, viewport.height - 100);

    // 贝塞尔曲线式移动（分多步）
    const steps = randInt(8, 16);
    const startX = randInt(200, viewport.width - 200);
    const startY = randInt(200, viewport.height - 200);

    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      // ease-in-out 缓动
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const cx = startX + (x - startX) * eased;
      const cy = startY + (y - startY) * eased;
      await page.mouse.move(cx, cy);
      await sleep(randInt(4, 18));
    }

    await sleep(randInt(100, 400));

    // 22% 概率附带滚轮
    if (Math.random() < 0.22) {
      await page.mouse.wheel(0, randInt(-200, 200));
      await sleep(randInt(200, 500));
    }
  }
}

// ─── 操作间停顿 ───

/**
 * 模拟真人"看一眼再操作"的停顿
 */
export async function humanDwell(
  minMs: number = 1500,
  maxMs: number = 3500,
): Promise<void> {
  const ms = randInt(minMs, maxMs);
  logger.debug(`停顿 ${ms}ms...`);
  await sleep(ms);
}

/**
 * 页面预热 — 打开页面后、操作前的轻量预热
 * 包括：短暂等待 + 鼠标闲逛 + 滚动
 */
export async function preSubmitWarmup(page: Page): Promise<void> {
  // 等待页面 JS 完全执行
  await sleep(randInt(800, 1500));

  // 轻微鼠标闲逛
  await humanMouseWander(page, 3);

  // 小幅滚动
  await page.mouse.wheel(0, randInt(50, 150));
  await sleep(randInt(300, 600));
  await page.mouse.wheel(0, randInt(-50, -20));
  await sleep(randInt(200, 400));
}
