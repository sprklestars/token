/**
 * 代理配置解析与预检
 *
 * 支持 .env 配置 PROXY_URL=http://user:pass@host:port,浏览器走代理注册,
 * 避免同 IP 批量注册触发 Vercel 风控。
 *
 * 两个关键处理:
 * 1. DNS 污染: 代理域名(如 gate.ipfoxy.io)本地解析被劫持,
 *    静态映射走 dns-fix,动态 CNAME 域名启动时通过 DoH 解析真实 IP 后直连
 * 2. 凭证预检: 启动前发一次 HTTP CONNECT,407(认证被拒)直接报错,
 *    避免"浏览器跑起来页面全超时"的隐性故障难排查
 */

import net from 'node:net';
import { logger } from './logger.js';
import { getDnsOverrides } from './dns-fix.js';

/** 浏览器可用的代理配置(Playwright proxy 参数格式) */
export interface ResolvedProxy {
  server: string;
  username?: string;
  password?: string;
}

/** DoH 服务(国内可达的公共 DNS over HTTPS) */
const DOH_ENDPOINTS = ['https://223.5.5.5/resolve', 'https://1.12.12.12/resolve'];

/** 用 DoH 解析域名(自动跟随 CNAME 链取 A 记录),失败返回 null */
async function dohResolve(host: string): Promise<string | null> {
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const res = await fetch(
        `${endpoint}?name=${encodeURIComponent(host)}&type=A`,
        { signal: AbortSignal.timeout(8000) },
      );
      if (!res.ok) continue;
      const data = await res.json() as { Answer?: Array<{ type: number; data: string }> };
      const aRecord = data.Answer?.filter((r) => r.type === 1).pop();
      if (aRecord) return aRecord.data;
    } catch { /* 尝试下一个 DoH */ }
  }
  return null;
}

/**
 * 解析 PROXY_URL 为浏览器可用的代理配置
 * - 空配置返回 null(直连)
 * - 代理域名被 DNS 污染时自动解析真实 IP,server 返回 IP 直连形式
 */
export async function resolveProxyConfig(proxyUrl: string): Promise<ResolvedProxy | null> {
  if (!proxyUrl.trim()) return null;

  let url: URL;
  try {
    url = new URL(proxyUrl.trim());
  } catch (e) {
    logger.warn(`PROXY_URL 格式错误(应为 http://user:pass@host:port),将直连: ${e}`);
    return null;
  }

  const host = url.hostname;
  const port = url.port || '8080';
  const username = decodeURIComponent(url.username) || undefined;
  const password = decodeURIComponent(url.password) || undefined;

  let serverHost = host;
  const overrides = getDnsOverrides();
  if (overrides[host]) {
    // 静态映射里有的直接用
    serverHost = overrides[host];
  } else {
    // 动态域名(如 gate.ipfoxy.io 的 CNAME 链)通过 DoH 解析真实 IP
    const ip = await dohResolve(host);
    if (ip) {
      serverHost = ip;
      logger.info(`代理域名 ${host} DoH 解析 -> ${ip}`);
    } else {
      logger.warn(`代理域名 ${host} DoH 解析失败,使用原始域名(可能被 DNS 污染)`);
    }
  }

  return {
    server: `${url.protocol}//${serverHost}:${port}`,
    username,
    password,
  };
}

/**
 * 代理连通性预检: 原生 socket 发一次 HTTP CONNECT
 * 返回代理响应状态码(200 = 隧道建立/认证通过,407 = 认证被拒)
 */
export function proxyConnectCheck(
  proxy: ResolvedProxy,
  timeoutMs = 12000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(proxy.server);
    const socket = net.connect({
      host: url.hostname,
      port: Number(url.port || 8080),
      timeout: timeoutMs,
    });

    socket.on('connect', () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${proxy.username}:${proxy.password ?? ''}`).toString('base64')}\r\n`
        : '';
      socket.write(
        `CONNECT api.ipify.org:443 HTTP/1.1\r\n` +
        `Host: api.ipify.org:443\r\n${auth}` +
        `Proxy-Connection: close\r\n\r\n`,
      );
    });

    socket.on('data', (buf) => {
      const statusLine = buf.toString('utf8').split('\r\n')[0] ?? '';
      const match = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/);
      socket.destroy();
      if (match) resolve(Number(match[1]));
      else reject(new Error(`代理响应异常: ${statusLine}`));
    });

    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('代理连接超时'));
    });
    socket.on('error', (e) => reject(e));
  });
}

/** 预检并返回可直接给 Playwright launch 的 proxy 参数;凭证无效时抛错 */
export async function prepareProxy(proxyUrl: string): Promise<ResolvedProxy | null> {
  const proxy = await resolveProxyConfig(proxyUrl);
  if (!proxy) return null;

  logger.info(`启用代理: ${proxy.server}${proxy.username ? ` (user: ${proxy.username.slice(0, 20)}...)` : ''}`);

  try {
    const status = await proxyConnectCheck(proxy);
    if (status === 200) {
      logger.success('代理预检通过(CONNECT 隧道建立)');
    } else if (status === 407) {
      throw new Error(
        `代理认证被拒(407): 请到代理服务商控制台核实 PROXY_URL 的账号密码/流量/会话时效`,
      );
    } else {
      logger.warn(`代理预检返回 HTTP ${status},仍尝试启动(可能是目标站点问题)`);
    }
  } catch (e) {
    // 网关不可达等硬错误也终止,避免浏览器起来后全部超时难排查
    if (e instanceof Error && e.message.includes('407')) throw e;
    throw new Error(`代理预检失败: ${e instanceof Error ? e.message : String(e)}`);
  }

  return proxy;
}
