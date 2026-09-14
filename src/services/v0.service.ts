/**
 * v0 API Key 创建辅助服务
 *
 * 提供两种创建 v0 API Key 的方式:
 * 1. 浏览器自动化 (v0-settings.ts) - 主方案
 * 2. Vercel REST API 创建 Auth Token - 备选方案
 */

import { logger } from '../utils/logger.js';
import type { BrowserContext } from 'patchright';

const VERCEL_API_BASE = 'https://api.vercel.com';

/**
 * 备选方案: 从浏览器中提取 Vercel session，
 * 然后调用 Vercel REST API 创建 Auth Token
 *
 * 注意: Vercel REST API 需要 Bearer Token 认证，不能直接用 session cookie。
 * 这里尝试多种方式获取认证凭证。
 */
export async function createVercelToken(
  context: BrowserContext,
  tokenName: string = 'auto-register',
): Promise<string | null> {
  try {
    logger.info('尝试通过 Vercel API 创建 Auth Token...');

    // 获取所有 vercel.com 的 cookies
    const cookies = await context.cookies('https://vercel.com');

    if (cookies.length === 0) {
      logger.warn('未找到 Vercel cookies，无法创建 token');
      return null;
    }

    // 构建完整的 Cookie header
    const cookieHeader = cookies.map((c: { name: string; value: string }) => `${c.name}=${c.value}`).join('; ');

    // 尝试查找 Bearer token 格式的 cookie
    const bearerCookie = cookies.find(
      (c: { name: string }) =>
        c.name === 'session_token' ||
        c.name === '__Host-session_token' ||
        c.name === 'vercel-session',
    );

    // 方式 1: 如果有明确的 session token cookie，直接用它作为 Bearer
    if (bearerCookie) {
      logger.info(`找到 session cookie: ${bearerCookie.name}`);
      const res = await fetch(`${VERCEL_API_BASE}/v3/user/tokens`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearerCookie.value}`,
        },
        body: JSON.stringify({ name: tokenName }),
      });

      if (res.ok) {
        const data = (await res.json()) as { bearerToken: string };
        logger.success(`Vercel Auth Token 已创建: ${data.bearerToken.slice(0, 10)}...`);
        return data.bearerToken;
      }
      logger.debug(`Bearer 方式失败: ${res.status}`);
    }

    // 方式 2: 发送完整 cookies
    const res2 = await fetch(`${VERCEL_API_BASE}/v3/user/tokens`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify({ name: tokenName }),
    });

    if (res2.ok) {
      const data = (await res2.json()) as { bearerToken: string };
      logger.success(`Vercel Auth Token 已创建 (cookie方式): ${data.bearerToken.slice(0, 10)}...`);
      return data.bearerToken;
    }

    logger.warn(`Vercel API 创建 token 失败: ${res2.status} ${await res2.text()}`);
    return null;
  } catch (error) {
    logger.warn('通过 Vercel API 创建 token 失败', error);
    return null;
  }
}
