/**
 * 浏览器启动抽象 - 批量模式每轮启动独立的浏览器进程
 *
 * 启动参数与 index.ts 单次 CLI 路径保持一致(反检测 + DNS 污染修复)。
 * 若 .env 配置了 PROXY_URL,自动走代理(含 DNS 污染域名解析与凭证预检)。
 */

import type { Browser } from 'patchright';
import { config } from '../config.js';
import { getHostResolverRules } from '../utils/dns-fix.js';
import { prepareProxy, type ResolvedProxy } from '../utils/proxy.js';
import { logger } from '../utils/logger.js';

/** 代理配置缓存(DoH 解析 + 预检有网络开销,批量每轮复用,5 分钟刷新) */
let proxyCache: { at: number; proxy: ResolvedProxy | null } | null = null;

/** 获取(并预检)代理配置;未配置返回 null,凭证无效抛错 */
export async function getProxy(): Promise<ResolvedProxy | null> {
  if (proxyCache && Date.now() - proxyCache.at < 5 * 60_000) {
    return proxyCache.proxy;
  }
  const proxy = await prepareProxy(config.proxy.url);
  proxyCache = { at: Date.now(), proxy };
  return proxy;
}

/** 启动一个带反检测参数的 Patchright Chromium(可选走代理) */
export async function launchChromium(headless: boolean): Promise<Browser> {
  const pw = await import('patchright');

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

  const proxy = await getProxy();

  const browser = await pw.chromium.launch({
    headless,
    args: [...launchArgs, '--no-sandbox'],
    ignoreDefaultArgs: ['--enable-automation'],
    ...(proxy
      ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } }
      : {}),
  } as any);

  logger.info(
    `浏览器已启动 (${headless ? 'headless' : 'headed'}${proxy ? `, 代理 ${proxy.server}` : ', 直连'})`,
  );
  return browser;
}
