/**
 * DNS 污染修复
 *
 * 背景: 本地 ISP DNS 对关键域名返回假 IP (59.82.113.122 / 29.240.0.x),
 * 导致 Node fetch 和浏览器访问全部超时。解决方案分两层:
 *
 * 1. Node 层: patch dns.lookup,undici fetch 底层用它解析,劫持后走真实 IP
 * 2. 浏览器层: 导出 getHostResolverRules(),供 Chromium 启动参数
 *    --host-resolver-rules 使用(Chromium 原生支持,无需管理员权限)
 *
 * 真实 IP 来源于阿里 DoH (223.5.5.5) 实测解析 (2026-09-08)。
 * 若 IP 变化,可在 .env 中用 DNS_OVERRIDES 覆盖,无需改代码:
 *   DNS_OVERRIDES=sms.fudugeek.xyz:1.2.3.4,mail.unsnow.org:5.6.7.8
 */

import dns from 'node:dns';

/** 被污染域名 → 真实 IP 的兜底映射(可用 DNS_OVERRIDES 覆盖) */
const dnsOverrides: Record<string, string> = {
  'sms.fudugeek.xyz': '47.243.80.108', // HeroSMS 接码平台 (阿里云)
  'mail.unsnow.org': '172.67.138.61',  // Unsnow Mail (Cloudflare)
  'vercel.com': '64.239.123.1',        // Vercel 注册页
  'www.vercel.com': '64.239.109.129',  // Vercel www
  'api.vercel.com': '76.76.21.112',    // Vercel REST API (创建 token 用)
};

// 解析 .env 的 DNS_OVERRIDES=host:ip,host:ip (覆盖默认值)
const envOverrides = process.env.DNS_OVERRIDES ?? '';
for (const pair of envOverrides.split(',')) {
  const trimmed = pair.trim();
  if (!trimmed) continue;
  const idx = trimmed.lastIndexOf(':');
  const host = trimmed.slice(0, idx).toLowerCase();
  const ip = trimmed.slice(idx + 1);
  if (host && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    dnsOverrides[host] = ip;
  }
}

// ─── Node 层: patch dns.lookup ───

const originalLookup = dns.lookup;

function patchedLookup(
  hostname: string,
  options: unknown,
  callback?: unknown,
): unknown {
  // 兼容 lookup(hostname, callback) 签名
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  const ip = dnsOverrides[String(hostname).toLowerCase()];
  if (ip && typeof callback === 'function') {
    const cb = callback as (err: Error | null, ...args: unknown[]) => void;
    if ((options as { all?: boolean })?.all) {
      cb(null, [{ address: ip, family: 4 }]);
    } else {
      cb(null, ip, 4);
    }
    return;
  }

  return originalLookup(
    hostname,
    options as dns.LookupOptions,
    callback as never,
  );
}

dns.lookup = patchedLookup as typeof dns.lookup;

// ─── 浏览器层: 生成 Chromium host-resolver-rules 参数 ───

/** 返回 --host-resolver-rules 的值,如 "MAP vercel.com 64.239.123.1, ..." */
export function getHostResolverRules(): string {
  return Object.entries(dnsOverrides)
    .map(([host, ip]) => `MAP ${host} ${ip}`)
    .join(', ');
}

/** 当前生效的映射表(诊断用) */
export function getDnsOverrides(): Record<string, string> {
  return { ...dnsOverrides };
}
