/**
 * 配置管理 - 从 .env 加载并校验配置
 */

import dotenv from 'dotenv';
import { resolve } from 'node:path';

dotenv.config({ path: resolve(process.cwd(), '.env') });

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`缺少必需的环境变量: ${key}，请在 .env 文件中配置`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  // Unsnow Mail
  email: {
    apiKey: required('EMAIL_API_KEY'),
    baseUrl: optional('EMAIL_API_BASE', 'https://mail.unsnow.org'),
  },

  // HeroSMS
  sms: {
    token: required('SMS_TOKEN'),
    baseUrl: optional('SMS_API_BASE', 'https://sms.fudugeek.xyz'),
  },

  // 浏览器
  browser: {
    headless: optional('HEADLESS', 'false') === 'true',
    chromeUserDataDir: optional('CHROME_USER_DATA_DIR', ''),
    screenshotDir: optional('SCREENSHOT_DIR', './screenshots'),
  },

  // 代理 (可选, http://user:pass@host:port;留空则直连)
  proxy: {
    url: optional('PROXY_URL', ''),
  },

  // 超时
  timeout: {
    emailPoll: parseInt(optional('EMAIL_POLL_TIMEOUT', '120000'), 10),
    smsPoll: parseInt(optional('SMS_POLL_TIMEOUT', '120000'), 10),
    page: parseInt(optional('PAGE_TIMEOUT', '30000'), 10),
  },
} as const;
