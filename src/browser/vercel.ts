/**
 * Vercel 注册页浏览器自动化
 *
 * 使用真实 Edge 浏览器 + 轻量隐身 + 人类行为模拟
 * 核心策略（参考 v0-auto 项目）：
 * - 轻量隐身：只清理自动化痕迹，不过度伪造指纹
 * - 粘贴模式输入：模拟 Ctrl+V 而非 fill()
 * - 人类化节奏：操作间停顿、鼠标闲逛、随机延迟
 * - Kasada 等待：等反 bot 脚本就绪后再操作
 * - 硬风控检测：遇到拒绝立即停止
 */

import type { Browser, Page, BrowserContext, Locator } from 'patchright';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';
import { detectHardBlock } from '../utils/stealth.js';
import {
  humanPaste, humanType, humanTypeOtp, humanClick, humanDwell,
} from '../utils/human.js';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const SCREENSHOT_DIR = resolve(config.browser.screenshotDir);

export class VercelBrowser {
  private browser: Browser;
  private page!: Page;
  private context!: BrowserContext;
  private screenshotCount = 0;
  private screenshotEnabled: boolean;
  readonly screenshotPaths: string[] = [];

  constructor(browser: Browser, screenshotEnabled = false) {
    this.browser = browser;
    this.screenshotEnabled = screenshotEnabled;
  }

  /** 初始化页面 */
  async init(): Promise<void> {
    this.context = this.browser.contexts()[0] || (await this.browser.newContext());
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(config.timeout.page);
    if (this.screenshotEnabled) {
      await mkdir(SCREENSHOT_DIR, { recursive: true });
    }
    logger.info('浏览器页面已初始化 (Patchright CDP 隐身)');
  }

  /** 截图（默认关闭，--screenshot 开启） */
  async screenshot(name: string): Promise<string> {
    if (!this.screenshotEnabled) return '';
    this.screenshotCount++;
    const filename = `${String(this.screenshotCount).padStart(2, '0')}_${name}.png`;
    const filepath = join(SCREENSHOT_DIR, filename);
    await this.page.screenshot({ path: filepath, fullPage: true, timeout: 10000 }).catch(() => {});
    this.screenshotPaths.push(filepath);
    return filepath;
  }

  /** 打开 Vercel 注册页面 */
  async navigateToSignup(): Promise<void> {
    logger.info('打开 Vercel 注册页面...');
    await this.page.goto('https://vercel.com/signup', {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    // Patchright 已处理 Kasada，仅等页面渲染
    await sleep(1500);
    await this.screenshot('01_signup_page');
    logger.success('注册页面已加载');
  }

  /** 选择邮箱注册 — 在 signup 页点击 Continue with Email */
  async selectEmailSignup(): Promise<void> {
    logger.info('选择邮箱注册方式...');

    // 确保在 signup 页面
    if (!this.page.url().includes('/signup')) {
      await this.page.goto('https://vercel.com/signup', {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    }
    await sleep(1500);

    // 快速预热：鼠标移动 + 滚动（精简版，保持必要的人机信号）
    const viewport = this.page.viewportSize() || { width: 1280, height: 800 };
    await this.page.mouse.move(viewport.width / 2, viewport.height / 2);
    await sleep(150);
    await this.page.mouse.move(viewport.width / 3, viewport.height / 3);
    await sleep(100);
    await this.page.mouse.wheel(0, 100);
    await sleep(150);
    await this.page.mouse.wheel(0, -50);
    await sleep(200);

    // 检查页面上是否有邮箱输入框（可能直接就在页面上）
    const directInput = this.page.locator('input[type="email"], input[name="email"]').first();
    if (await directInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      await this.screenshot('02_email_form_ready');
      logger.success('邮箱输入框已在页面上');
      return;
    }

    // 点击 "Continue with Email"（使用 humanClick 完整模拟鼠标移动+按下+释放）
    const link = this.page.locator('text=Continue with Email').first();
    if (await link.isVisible({ timeout: 5000 }).catch(() => false)) {
      await humanClick(this.page, link);
      logger.info('humanClick 点击了 Continue with Email');
    } else {
      // JS 备选
      await this.page.evaluate(() => {
        const els = document.querySelectorAll('a, span, [role="link"], button');
        for (const el of els) {
          if (el.textContent?.includes('Continue with Email')) {
            (el as HTMLElement).click();
            break;
          }
        }
      });
      logger.warn('回退到 JS 点击');
    }

    await sleep(1500); // 等待表单展开
    await this.screenshot('02_after_click_debug');

    // 等待邮箱输入框出现
    const hasInput = await this.page.locator('input[type="email"], input[name="email"]')
      .waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    if (!hasInput) {
      // 最后尝试: 检查页面是否已导航到别处
      const currentUrl = this.page.url();
      logger.warn(`点击后未找到邮箱输入框，当前 URL: ${currentUrl}`);
      await this.screenshot('error_no_email_form');
      throw new Error('点击 Continue with Email 后未找到邮箱输入框');
    }

    await this.screenshot('02_email_selected');
    logger.success('邮箱注册表单已展开');
  }

  /** 输入邮箱地址并提交 */
  async enterEmail(email: string): Promise<void> {
    logger.info(`输入邮箱: ${email}`);

    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[placeholder*="email" i]',
      'input[placeholder*="邮箱"]',
      'input[id*="email" i]',
    ];

    let found = false;
    for (const selector of emailSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 3000 })) {
          // 粘贴模式输入（最接近真人行为）
          await humanPaste(this.page, el, email);
          found = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!found) {
      await this.screenshot('error_no_email_input');
      throw new Error('找不到邮箱输入框');
    }

    await this.screenshot('03_email_entered');

    // 提交前短暂停顿
    await sleep(500);

    // 点击提交按钮
    await this.clickSubmitButton();

    // 提交后快速检查硬风控
    await sleep(1000);
    if (await detectHardBlock(this.page)) {
      await this.screenshot('error_hard_block');
      throw new Error('Vercel 硬风控：注册被拒绝。请尝试切换代理节点后重试');
    }

    await this.screenshot('04_email_submitted');
    logger.success('邮箱已提交');
  }

  /** 输入邮箱 OTP 验证码 */
  async enterEmailOtp(code: string): Promise<void> {
    logger.info('输入邮箱 OTP 验证码...');

    const otpSelectors = [
      'input[name="otp"]',
      'input[name="code"]',
      'input[name="verificationCode"]',
      'input[autocomplete="one-time-code"]',
      'input[type="text"][placeholder*="code" i]',
      'input[id*="otp" i]',
      'input[id*="code" i]',
    ];

    let filled = false;
    for (const selector of otpSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 3000 })) {
          // OTP 快速逐字输入
          await humanTypeOtp(this.page, el, code);
          filled = true;
          logger.info('使用单输入框方式填入验证码');
          break;
        }
      } catch {
        continue;
      }
    }

    // 多输入框模式 - 逐格精确填写
    if (!filled) {
      try {
        const inputs = this.page.locator('input[type="text"], input[type="tel"], input[type="number"]');
        const count = await inputs.count();

        if (count >= 4 && count <= 8) {
          logger.info(`OTP: 检测到 ${count} 个独立输入框，逐格填写`);
          for (let i = 0; i < code.length && i < count; i++) {
            await inputs.nth(i).click();
            await sleep(150);
            await inputs.nth(i).fill(code[i]);
            await sleep(100);
          }
          filled = true;
        }
      } catch {
        // continue
      }
    }

    if (!filled) {
      await this.screenshot('error_no_otp_input');
      throw new Error('找不到 OTP 验证码输入框');
    }

    await this.screenshot('05_otp_entered');

    // 停顿后提交
    await sleep(800);

    try {
      await this.clickSubmitButton();
    } catch {
      logger.debug('OTP 页面自动提交或无提交按钮');
    }

    await sleep(1000);
    await this.screenshot('06_otp_submitted');
    logger.success('OTP 验证码已提交');
  }

  /** 选择手机验证的国家 — US 默认跳过 */
  async selectPhoneCountry(countryName: string = 'United States'): Promise<void> {
    // US 是 Vercel 默认国家，直接跳过
    if (countryName.includes('United States') || countryName.includes('USA')) {
      logger.info('手机验证国家: 美国 (默认，跳过选择)');
      return;
    }

    logger.info(`选择手机验证国家: ${countryName}`);

    // 如果是美国（默认），检查是否已经是默认选择
    if (countryName.includes('United States')) {
      const phoneInput = this.page.locator('input[type="tel"]').first();
      if (await phoneInput.isVisible({ timeout: 3000 }).catch(() => false)) {
        logger.success('国家已默认为美国');
        await this.screenshot('07_country_selected');
        return;
      }
    }

    // 非美国 或 需要切换国家：用 JS 点击国旗下拉并选择
    const selected = await this.page.evaluate((targetCountry: string) => {
      // 点击国旗/国家下拉按钮
      const buttons = document.querySelectorAll('button, [role="combobox"], [class*="flag"], [class*="country"]');
      for (const btn of buttons) {
        const text = btn.textContent?.trim() || '';
        // 找到国旗区域的小按钮（通常包含国旗 emoji 或区号）
        if (btn.closest('[class*="phone"]') || btn.closest('[class*="country"]') ||
            btn.getAttribute('aria-label')?.includes('country') ||
            btn.getAttribute('aria-label')?.includes('Country')) {
          (btn as HTMLElement).click();
          break;
        }
      }
      return true;
    }, countryName);

    await sleep(1000);

    // 在下拉列表中选择目标国家
    const countrySelected = await this.page.evaluate((targetCountry: string) => {
      // 查找下拉列表中的国家选项
      const options = document.querySelectorAll('[role="option"], [role="listbox"] *, li, [class*="option"]');
      for (const opt of options) {
        const text = opt.textContent?.trim() || '';
        if (text.toLowerCase().includes(targetCountry.toLowerCase())) {
          (opt as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, countryName);

    if (countrySelected) {
      logger.success(`已选择国家: ${countryName}`);
    } else {
      logger.warn(`未在下拉列表中找到 ${countryName}，尝试 Playwright locator`);

      // 回退: 用 Playwright locator
      const option = this.page.locator(`text=${countryName}`).first();
      if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
        await humanClick(this.page, option);
        logger.success(`通过 locator 选择了国家: ${countryName}`);
      } else {
        logger.warn(`无法选择 ${countryName}，使用默认国家`);
      }
    }

    await sleep(1000);
    await this.screenshot('07_country_selected');
  }

  /** 输入手机号码 */
  async enterPhoneNumber(phoneNumber: string, countryPhoneCode?: number): Promise<void> {
    let localNumber = phoneNumber;

    // 去掉国家码前缀
    if (countryPhoneCode) {
      const prefix = String(countryPhoneCode);
      if (phoneNumber.startsWith(prefix)) {
        localNumber = phoneNumber.slice(prefix.length);
        // Vercel 已自动填入 +{code}，只需输入去掉国家码后的本地号码
        // 注意：不要加前导 0，因为 Vercel 的 +{code} 已包含国际格式
        logger.info(`去掉国家码 +${prefix}，本地号码: ${localNumber}`);
      }
    } else {
      // 回退: 自动检测美国号码
      if (phoneNumber.startsWith('1') && phoneNumber.length === 11) {
        localNumber = phoneNumber.slice(1);
        logger.info(`去掉美国国家码前缀，本地号码: ${localNumber}`);
      }
    }

    logger.info(`输入手机号码: ${localNumber}`);

    // 用 JS 标记疑似手机号输入框(placeholder / phone class 等特征)
    await this.page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      for (const input of inputs) {
        if (input.type === 'tel' || input.getAttribute('inputmode') === 'tel' ||
            input.placeholder?.match(/\d{3}.*\d{3}/) || // placeholder like (201) 555-0123
            input.closest('[class*="phone"]')) {
          input.setAttribute('data-v0-phone', 'true');
          return true;
        }
      }
      return false;
    }).catch(() => false);

    // 候选选择器(精确 → 宽泛),在整体时间窗内轮询等待。
    // 批量模式下页面加载可能较慢,不能用一次性短超时
    const selectors = [
      'input[data-v0-phone="true"]',
      'input[type="tel"]',
      'input[autocomplete="tel"]',
      'input[autocomplete="tel-national"]',
      'input[name*="phone" i]',
      'input[id*="phone" i]',
      'input[inputmode="tel"]',
    ];

    let phoneInput: Locator | null = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !phoneInput) {
      for (const selector of selectors) {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
          phoneInput = el;
          logger.info(`定位到手机号输入框: ${selector}`);
          break;
        }
      }
      if (!phoneInput) await sleep(600);
    }

    if (!phoneInput) {
      await this.screenshot('error_no_phone_input');
      throw new Error('找不到手机号输入框(15s 内未出现)');
    }

    // 模拟真人键盘输入(点击 → 清空 → 逐字键入),keyboard 事件必然触发 React onChange。
    // 注意: 不要用 JS evaluate 直接设 value —— 对 Vercel 的受控组件不生效
    // (React state 不更新,界面显示空白,但流程误以为已填入)
    await humanType(this.page, phoneInput, localNumber);

    // 校验实际填入的值(受控组件 state 更新后 inputValue 才会返回新值),
    // 校验不通过重试一次,仍不通过则终止本轮(避免空号提交浪费号码费)
    const digits = (s: string) => s.replace(/\D/g, '');
    let actual = await phoneInput.inputValue().catch(() => '');
    if (digits(actual) !== digits(localNumber)) {
      logger.warn(`手机号校验失败(输入框当前值 "${actual}"),重试一次...`);
      await sleep(800);
      await humanType(this.page, phoneInput, localNumber);
      actual = await phoneInput.inputValue().catch(() => '');
      if (digits(actual) !== digits(localNumber)) {
        await this.screenshot('error_phone_value_mismatch');
        throw new Error(`手机号填写校验失败: 期望 ${localNumber}, 实际 "${actual}"`);
      }
    }
    logger.success(`手机号已填入并校验通过: ${actual}`);

    await this.screenshot('08_phone_entered');

    await sleep(500);
    await this.clickSubmitButton();
    await sleep(800);
    await this.screenshot('09_phone_submitted');
    logger.success('手机号已提交');
  }

  /** 输入短信验证码 */
  async enterSmsCode(code: string): Promise<void> {
    logger.info('输入短信验证码...');

    const codeSelectors = [
      'input[name="code"]',
      'input[name="smsCode"]',
      'input[name="verificationCode"]',
      'input[autocomplete="one-time-code"]',
      'input[type="text"][placeholder*="code" i]',
      'input[id*="code" i]',
      'input[id*="sms" i]',
    ];

    let filled = false;
    for (const selector of codeSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 3000 })) {
          await humanTypeOtp(this.page, el, code);
          filled = true;
          break;
        }
      } catch {
        continue;
      }
    }

    // 多输入框模式 - 逐格精确填写
    if (!filled) {
      try {
        const inputs = this.page.locator('input[type="text"], input[type="tel"], input[type="number"]');
        const count = await inputs.count();
        if (count >= 4 && count <= 8) {
          logger.info(`检测到 ${count} 个独立输入框，逐格填写`);
          // 逐格点击并填写，确保每个框都能接收到字符
          for (let i = 0; i < code.length && i < count; i++) {
            await inputs.nth(i).click();
            await sleep(150);
            await inputs.nth(i).fill(code[i]);
            await sleep(100);
          }
          filled = true;
        }
      } catch {
        // continue
      }
    }

    if (!filled) {
      await this.screenshot('error_no_sms_input');
      throw new Error('找不到短信验证码输入框');
    }

    await this.screenshot('10_sms_code_entered');

    await sleep(500);

    try {
      await this.clickSubmitButton();
    } catch {
      logger.debug('短信验证码页面自动提交或无提交按钮');
    }

    await sleep(1000);
    await this.screenshot('11_sms_submitted');
    logger.success('短信验证码已提交');
  }

  /** 等待注册完成 + 处理 onboarding 页面 */
  async waitForDashboard(timeoutMs: number = 120000): Promise<void> {
    logger.info('等待注册完成并跳转到 Dashboard...');

    const startTime = Date.now();
    const checkInterval = 1500;

    while (Date.now() - startTime < timeoutMs) {
      const url = this.page.url();

      // ── 已到达 Dashboard / 主页 ──
      if (
        url.includes('/dashboard') ||
        url.includes('/projects') ||
        url.includes('vercel.com/home') ||
        url.includes('vercel.com/new') ||
        url === 'https://vercel.com/'
      ) {
        await this.screenshot('12_dashboard_reached');
        logger.success(`注册成功！当前页面: ${url}`);
        return;
      }

      // ── 检测并处理 onboarding 页面 ──
      const handled = await this.handleOnboardingPage();
      if (handled) {
        // onboarding 页面已处理，继续等待下一跳
        await sleep(1000);
        continue;
      }

      // ── 检查错误提示 ──
      try {
        const errorEl = this.page.locator('[role="alert"], .error, .text-red').first();
        if (await errorEl.isVisible({ timeout: 1000 }).catch(() => false)) {
          const errorText = await errorEl.textContent();
          if (errorText && errorText.trim()) {
            await this.screenshot('error_dashboard_check');
            throw new Error(`页面错误: ${errorText.trim()}`);
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith('页面错误')) throw e;
      }

      await sleep(checkInterval);
    }

    // 超时不一定失败——截图看看当前状态
    await this.screenshot('error_dashboard_timeout');
    const finalUrl = this.page.url();
    logger.warn(`等待 Dashboard 超时，当前 URL: ${finalUrl}`);

    // 如果 URL 看起来像注册成功了（不在 signup/login 页），也算成功
    if (!finalUrl.includes('/signup') && !finalUrl.includes('/login')) {
      logger.success(`URL 看起来已离开注册页，视为注册成功`);
      return;
    }

    throw new Error(`等待 Dashboard 超时 (${timeoutMs / 1000}s)`);
  }

  /** 检测并处理各类 onboarding 页面，返回是否处理成功 */
  private async handleOnboardingPage(): Promise<boolean> {
    // 获取页面文本内容
    let bodyText = '';
    try {
      bodyText = (await this.page.locator('body').innerText({ timeout: 2000 }).catch(() => '')) || '';
    } catch {
      return false;
    }
    if (!bodyText || bodyText.length < 5) return false;
    const lower = bodyText.toLowerCase();
  
    // ── 通用: 选择选项 + 提交 辅助函数 ──
    const selectOption = async (preferTexts: string[], fallbackFirst = true): Promise<boolean> => {
      for (const t of preferTexts) {
        // 用 substring 匹配而非精确匹配，兼容空格/引号差异
        const btn = this.page.locator(`text=${t}`).first();
        if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
          await humanClick(this.page, btn);
          logger.success(`已选择: ${t}`);
          return true;
        }
      }
      // 回退: 选第一个可点击的选项
      if (fallbackFirst) {
        const options = this.page.locator('[role="radio"], [role="option"], input[type="radio"], input[type="checkbox"]');
        const count = await options.count();
        if (count > 0) {
          await humanClick(this.page, options.first());
          logger.info(`回退选择了第 1 个选项 (共 ${count} 个)`);
          return true;
        }
      }
      return false;
    };
  
    const submit = async () => {
      await sleep(300);
      await this.clickSubmitButton();
      await sleep(1200);
    };
  
    // ──────────────────── 已知页面 ────────────────────
  
    // 1. "How do you plan to use Vercel?" — 使用意图
    if (lower.includes('how do you plan to use') || (lower.includes('welcome') && lower.includes('plan'))) {
      logger.info('onboarding: 使用意图选择');
      await this.screenshot('ob_usage_plan');
      await selectOption(['Personal', 'Hobby', 'Individual', 'Myself']);
      await this.screenshot('ob_usage_selected');
      await submit();
      return true;
    }
  
    // 2. "What best describes your role?" — 角色
    if (lower.includes('describe your role') || lower.includes('best describes')) {
      logger.info('onboarding: 角色选择');
      await this.screenshot('ob_role');
      await selectOption(['Developer', 'Engineer', 'Programmer']);
      await submit();
      return true;
    }
  
    // 3. "How big is your team?" — 团队规模
    if (lower.includes('how big is your team') || lower.includes('team size') || lower.includes('how many people')) {
      logger.info('onboarding: 团队规模');
      await this.screenshot('ob_team_size');
      // 选最小: Just me / 1 / Solo / 1-5
      await selectOption(['Just me', '1', 'Solo', 'Only me', '1-5', '1 - 5', 'Myself']);
      await submit();
      return true;
    }
  
    // 4. "What are you building?" — 构建内容 (button chips + Done)
    if (lower.includes('what are you building') || lower.includes('what do you build')) {
      logger.info('onboarding: 构建内容');
      await this.screenshot('ob_building');

      // 这些选项是 button-style chips，不是 checkbox
      // 用 JS 点击前几个选项（最可靠）
      await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        const optionKeywords = ['ai app', 'ai agent', 'web app', 'static site', 'internal tool', 'api', 'other'];
        let clicked = 0;
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (optionKeywords.some(kw => text.includes(kw))) {
            btn.click();
            clicked++;
            if (clicked >= 3) break; // 选前 3 个就够了
          }
        }
      });
      logger.info('已通过 JS 点击选项 chips');
      await sleep(1000);

      // 点击 Done 按钮 (用 JS 直接点击，最可靠)
      await this.page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent?.trim() === 'Done') {
            btn.click();
            break;
          }
        }
      });
      logger.info('已通过 JS 点击 Done 按钮');

      await sleep(2500);
      await this.screenshot('ob_building_done');
      return true;
    }
  
    // 5. "Choose a plan" — 选择计划 + 填团队名
    if (lower.includes('choose a plan') || lower.includes('pick a plan') ||
        (lower.includes('personal') && lower.includes('pro') && lower.includes('commercial'))) {
      logger.info('onboarding: 选择计划');
      await this.screenshot('ob_plan');

      // 选 personal / free / hobby
      await selectOption([
        'I\'m working on personal projects',
        'Personal',
        'Hobby',
        'Free',
        'personal projects',
      ]);

      // 同一个页面可能还有 Team 名称输入框
      await sleep(500);
      const nameInputs = this.page.locator('input[type="text"], input[name*="name" i], input[name*="slug" i], input[name*="team" i]');
      const inputCount = await nameInputs.count();
      for (let i = 0; i < inputCount; i++) {
        const inp = nameInputs.nth(i);
        if (await inp.isVisible({ timeout: 1000 }).catch(() => false)) {
          const val = await inp.inputValue().catch(() => '');
          if (!val || val.length < 2) {
            const randName = 'team-' + Math.random().toString(36).slice(2, 8);
            await inp.fill(randName);
            logger.info(`已填入团队名: ${randName}`);
          } else {
            logger.info(`团队名已有值: ${val}`);
          }
        }
      }

      await this.screenshot('ob_plan_filled');
      await submit();
      return true;
    }
  
    // 6. 团队名/用户名输入页
    if (lower.includes('team name') || lower.includes('team slug') || lower.includes('choose a name')) {
      logger.info('onboarding: 团队名称输入');
      await this.screenshot('ob_team_name');
      // 检查是否已有默认值
      const nameInput = this.page.locator('input[type="text"], input[name*="name" i], input[name*="slug" i]').first();
      if (await nameInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        const value = await nameInput.inputValue().catch(() => '');
        if (!value || value.length < 2) {
          // 生成随机团队名
          const randName = 'team-' + Math.random().toString(36).slice(2, 8);
          await nameInput.fill(randName);
          logger.info(`已填入团队名: ${randName}`);
        } else {
          logger.info(`团队名已有默认值: ${value}`);
        }
      }
      await submit();
      return true;
    }
  
    // 7. 账户类型: Hobby / Pro / Enterprise
    if ((lower.includes('hobby') || lower.includes('free')) &&
        (lower.includes('pro') || lower.includes('team') || lower.includes('choose'))) {
      logger.info('onboarding: 账户类型');
      await this.screenshot('ob_account_type');
      await selectOption(['Hobby', 'Free', 'Personal', 'Hobby (Free)']);
      await submit();
      return true;
    }
  
    // ──────────────────── 通用回退: 任何未识别的选择页 ────────────────────
    // 检测页面是否有可选项（radio/checkbox/可点击卡片）
    const selectableItems = this.page.locator('[role="radio"], [role="option"], input[type="radio"], input[type="checkbox"]');
    const selectCount = await selectableItems.count().catch(() => 0);
  
    if (selectCount > 0) {
      logger.info(`onboarding: 未知选择页面 (检测到 ${selectCount} 个选项)，尝试选择...`);
      await this.screenshot('ob_unknown_select');
      await selectOption([], true);
      await submit();
      return true;
    }
  
    // 检测是否有输入框（可能是文本输入页）
    const textInputs = this.page.locator('input[type="text"], textarea').first();
    if (await textInputs.isVisible({ timeout: 1000 }).catch(() => false)) {
      logger.info('onboarding: 未知输入页面，尝试跳过...');
      await this.screenshot('ob_unknown_input');
      await submit();
      return true;
    }
  
    // 检测是否有 Skip / Next 按钮
    const skipBtn = this.page.locator('text="Skip", text="Next", text="Later"').first();
    if (await skipBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      logger.info('onboarding: 检测到 Skip 按钮');
      await this.screenshot('ob_skip');
      await humanClick(this.page, skipBtn);
      await sleep(2000);
      return true;
    }
  
    return false;
  }

  async getAuthCookies(): Promise<Record<string, string>> {
    const cookies = await this.context.cookies();
    const cookieMap: Record<string, string> = {};
    for (const cookie of cookies) {
      cookieMap[cookie.name] = cookie.value;
    }
    return cookieMap;
  }

  getCurrentUrl(): string {
    return this.page.url();
  }

  getPage(): Page {
    return this.page;
  }

  getContext(): BrowserContext {
    return this.context;
  }

  async close(): Promise<void> {
    try {
      await this.browser.close();
      logger.info('浏览器已关闭');
    } catch {
      // ignore
    }
  }

  /** 通用提交按钮 — 策略轮换 */
  private async clickSubmitButton(): Promise<void> {
    const submitSelectors = [
      'button[type="submit"]',
      'button:has-text("Continue")',
      'button:has-text("Submit")',
      'button:has-text("Verify")',
      'button:has-text("Next")',
      'button:has-text("Sign up")',
      'input[type="submit"]',
    ];

    for (const selector of submitSelectors) {
      try {
        const el = this.page.locator(selector).first();
        if (await el.isVisible({ timeout: 2000 })) {
          await humanClick(this.page, el);
          logger.debug(`点击了按钮: ${selector}`);
          return;
        }
      } catch {
        continue;
      }
    }

    // Enter 键回退
    await this.page.keyboard.press('Enter');
    logger.debug('使用 Enter 键提交');
  }
}
