/**
 * CLI 入口 - 解析参数并启动自动注册流程
 *
 * 用法:
 *   npm start              # headed 模式运行 (默认)
 *   npm start -- --headed  # 显示浏览器窗口
 *   npm run dry-run        # 仅测试 API (不启动浏览器)
 *
 * 参数:
 *   --headed    显示浏览器窗口 (覆盖 .env 中的 HEADLESS)
 *   --dry-run   仅测试邮箱/接码 API，不启动浏览器
 *   --timeout N 自定义超时时间 (毫秒)
 *   --browser   浏览器类型: chromium (默认) | firefox | camoufox
 */

// DNS 污染修复必须在所有网络请求之前加载(副作用: patch dns.lookup)
import './utils/dns-fix.js';
import { getHostResolverRules, getDnsOverrides } from './utils/dns-fix.js';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { createMailbox } from './services/email.service.js';
import { smsClient } from './services/sms.service.js';
import { runRegistration } from './orchestrator.js';
import { getProxy } from './browser/launch.js';
import type { Browser, BrowserContext } from 'patchright';

// ─── 解析命令行参数 ───
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const forceHeaded = args.includes('--headed');
const enableScreenshots = args.includes('--screenshot');
const timeoutIdx = args.indexOf('--timeout');
const customTimeout = timeoutIdx >= 0 ? parseInt(args[timeoutIdx + 1], 10) : undefined;
const browserIdx = args.indexOf('--browser');
const browserType = browserIdx >= 0 ? args[browserIdx + 1] : 'chromium';

if (customTimeout) {
  // 覆盖默认超时
  (config.timeout as { emailPoll: number }).emailPoll = customTimeout;
  (config.timeout as { smsPoll: number }).smsPoll = customTimeout;
  (config.timeout as { page: number }).page = customTimeout;
}

// ─── Dry Run: 仅测试 API ───
async function dryRun(): Promise<void> {
  logger.info('=== Dry Run 模式: 仅测试 API ===');

  // 测试邮箱 API
  logger.step(1, 3, '测试邮箱服务 API');
  const mailbox = await createMailbox();
  logger.info(`邮箱地址: ${mailbox.address}`);
  logger.info(`邮箱 ID:  ${mailbox.id}`);

  // 测试接码 API
  logger.step(2, 3, '测试接码平台 API');
  await smsClient.login();
  const usCountryId = await smsClient.findUsCountryId();
  const vercelCode = await smsClient.findVercelServiceCode();
  logger.info(`美国 ID: ${usCountryId}`);
  logger.info(`Vercel service: ${vercelCode}`);

  // 验证新报价端点 + 国家选择逻辑(不买号)
  const target = await smsClient.findCheapestVercelCountry();
  logger.info(`报价验证: ${target.name} (ID: ${target.id}, $${target.price}, 区号 +${target.phoneCode})`);

  // 验证 SSE 余额查询与孤儿激活清理 (不实际买号——新平台购号后 2 分钟内不可取消,买测试号会白挂 $0.1)
  logger.step(3, 3, '查询余额与激活列表 (SSE)');
  const recovered = await smsClient.recoverOrphanActivations();
  if (recovered > 0) {
    logger.warn(`已清理 ${recovered} 个孤儿激活`);
  }

  logger.success('=== Dry Run 完成 ===');
}

// ─── 完整注册流程 ───
async function fullRun(): Promise<void> {
  logger.info('=== Vercel 自动注册 ===');
  logger.info(`浏览器模式: ${forceHeaded ? 'headed (显示窗口)' : config.browser.headless ? 'headless' : 'headed'}`);
  const overrides = getDnsOverrides();
  logger.info(`DNS 修复生效: ${Object.keys(overrides).length} 个域名 -> ${Object.values(overrides).join(', ')}`);

  // 清理上次异常退出可能遗留的孤儿激活(挂着的号会持续计费),顺便查看余额
  await smsClient.login();
  await smsClient.recoverOrphanActivations();

  // 启动浏览器
  let browser: Browser;
  const headless = forceHeaded ? false : config.browser.headless;

  try {
    if (browserType === 'camoufox') {
      // Camoufox 方案 - Firefox 内核反检测浏览器
      const { Camoufox } = await import('camoufox-js');
      logger.info('正在启动 Camoufox 浏览器...');
      const result = await Camoufox({
        headless,
        firefoxUserPrefs: {
          'network.http.http2.enabled': false,
          'network.http.http2.enabled.deps': false,
          'network.http.http2.push': false,
          'network.http.http3.enable': false,
        },
      });
      if ('contexts' in result && typeof (result as any).contexts === 'function') {
        browser = result as unknown as Browser;
      } else {
        browser = (result as any).browser()! as unknown as Browser;
      }
      logger.success('Camoufox 浏览器已启动');
    } else {
      // 真实 Edge/Chrome 浏览器方案 (推荐)
      const pw = await import('patchright');

      // 确定浏览器 channel: edge=真实 Edge, chrome=真实 Chrome, chromium=Playwright 内置
      const channel = browserType === 'edge' ? 'msedge'
        : browserType === 'chrome' ? 'chrome'
        : undefined;

      logger.info(`正在启动 ${browserType.toUpperCase()} 浏览器${channel ? ` (channel: ${channel})` : ''}...`);

      const launchArgs = [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-background-timer-throttling',
        '--force-webrtc-ip-handling-policy',
        '--disable-http2',  // 避免 Cloudflare HTTP/2 协议错误
        '--lang=zh-CN',
        // DNS 污染修复: 把被劫持的域名固定到真实 IP
        `--host-resolver-rules=${getHostResolverRules()}`,
      ];

      if (channel) {
        // 真实浏览器: 使用 launchPersistentContext + channel
        const tmpDir = config.browser.chromeUserDataDir || '';
        const contextOpts: Record<string, unknown> = {
          channel,
          headless,
          args: launchArgs,
          viewport: { width: 1366, height: 900 },
          locale: 'zh-CN',
        };

        if (tmpDir) {
          // 持久化上下文（保留登录态）
          const context = await pw.chromium.launchPersistentContext(tmpDir, contextOpts as any);
          browser = context.browser()!;
        } else {
          // InPrivate 模式: 每轮新建
          browser = await pw.chromium.launch({
            ...contextOpts,
            args: [...launchArgs, '--inprivate'],
          } as any);
        }
      } else {
        // Patchright 内置 Chromium (推荐)
        const proxy = await getProxy();
        browser = await pw.chromium.launch({
          headless,
          args: [
            ...launchArgs,
            '--no-sandbox',
          ],
          ignoreDefaultArgs: ['--enable-automation'],
          ...(proxy
            ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } }
            : {}),
        } as any);
      }

      logger.success(`${browserType.toUpperCase()} 浏览器已启动`);
    }
  } catch (error) {
    logger.error(`启动 ${browserType} 浏览器失败`);
    logger.error(String(error));
    if (browserType === 'camoufox') {
      logger.info('请确保已安装: npm install && npx camoufox-js fetch');
    } else if (browserType === 'edge' || browserType === 'chrome') {
      logger.info(`请确保系统已安装 ${browserType === 'edge' ? 'Microsoft Edge' : 'Google Chrome'}`);
    }
    throw error;
  }

  const startTime = Date.now();

  try {
    const result = await runRegistration(browser, enableScreenshots);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    logger.info('');
    logger.info('═══════════════════════════════════════════');
    logger.success(`注册完成! 耗时: ${elapsed}s`);
    logger.info('═══════════════════════════════════════════');
    logger.info(`  邮箱:        ${result.email.address}`);
    logger.info(`  手机号:      ${result.phone.number}`);
    logger.info(`  Vercel:      ${result.vercel.registered ? '已注册' : '未完成'}`);
    logger.info(`  v0 API Key:  ${result.v0.apiKey ? result.v0.apiKey.slice(0, 30) + '...' : '未创建'}`);
    logger.info(`  截图数:      ${result.screenshots.length}`);
    logger.info('═══════════════════════════════════════════');
  } catch (error) {
    // runRegistration 内部已处理浏览器关闭
    throw error;
  }
}

// ─── 主入口 ───
async function main(): Promise<void> {
  try {
    if (isDryRun) {
      await dryRun();
    } else {
      await fullRun();
    }
  } catch (error) {
    logger.error(`执行失败: ${error}`);
    if (error instanceof Error && error.stack) {
      logger.debug(error.stack);
    }
    process.exit(1);
  }
}

main();
