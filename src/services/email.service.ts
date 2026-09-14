/**
 * Unsnow Mail 邮箱服务 API 封装
 *
 * 文档: https://mail.unsnow.org
 * 认证: Bearer Token
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { retry, sleep } from '../utils/retry.js';

interface Mailbox {
  id: string;
  address: string;
  domain: string;
  localPart: string;
}

interface Message {
  id: string;
  subject?: string;
  from?: string;
  receivedAt: string;
  bodyPreview?: string;
}

interface MessageDetail extends Message {
  bodyText?: string;
  bodyHtml?: string;
  text?: string;   // Unsnow API 实际返回的纯文本字段
  html?: string;   // Unsnow API 实际返回的 HTML 字段
}

const BASE = config.email.baseUrl;
const HEADERS = {
  Authorization: `Bearer ${config.email.apiKey}`,
  'Content-Type': 'application/json',
};

/** 创建一个随机域名的临时邮箱 */
export async function createMailbox(): Promise<Mailbox> {
  logger.info('正在创建临时邮箱...');

  const res = await fetch(`${BASE}/api/v1/mailboxes`, {
    method: 'POST',
    headers: HEADERS,
    body: '{}',
  });

  if (!res.ok) {
    throw new Error(`创建邮箱失败: ${res.status} ${await res.text()}`);
  }

  const data = await res.json() as Mailbox;
  logger.success(`邮箱已创建: ${data.address}`);
  return data;
}

/** 列出指定邮箱的所有邮件 */
export async function listMessages(mailboxId: string): Promise<Message[]> {
  const res = await fetch(`${BASE}/api/v1/mailboxes/${mailboxId}/messages`, {
    headers: HEADERS,
  });

  if (!res.ok) {
    throw new Error(`获取邮件列表失败: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  // API 可能返回数组或 Hydra 格式对象 {"hydra:member": [...]}
  if (Array.isArray(data)) return data as Message[];
  if (data && typeof data === 'object') {
    return (
      data['hydra:member'] ||
      data.messages ||
      data.data ||
      data.items ||
      []
    ) as Message[];
  }
  return [];
}

/** 获取邮件完整内容 */
export async function getMessage(
  mailboxId: string,
  messageId: string,
): Promise<MessageDetail> {
  const res = await fetch(
    `${BASE}/api/v1/mailboxes/${mailboxId}/messages/${messageId}`,
    { headers: HEADERS },
  );

  if (!res.ok) {
    throw new Error(`获取邮件详情失败: ${res.status} ${await res.text()}`);
  }

  const raw = await res.json() as any;
  // Unsnow API 返回 text/html 字段，映射到我们的 bodyText/bodyHtml
  return {
    ...raw,
    bodyText: raw.text || raw.bodyText || '',
    bodyHtml: raw.html || raw.bodyHtml || '',
  } as MessageDetail;
}

/** 轮询等待邮件到达，返回第一封邮件的内容 */
export async function waitForEmail(
  mailboxId: string,
  timeoutMs: number = config.timeout.emailPoll,
): Promise<MessageDetail> {
  logger.info(`等待邮件到达 (超时 ${timeoutMs / 1000}s)...`);

  const startTime = Date.now();
  const pollInterval = 2000; // 2 秒轮询一次（加速）

  while (Date.now() - startTime < timeoutMs) {
    const messages = await listMessages(mailboxId);

    if (messages.length > 0) {
      logger.success(`收到 ${messages.length} 封邮件`);
      return getMessage(mailboxId, messages[0].id);
    }

    logger.debug('暂无邮件，继续轮询...');
    await sleep(pollInterval);
  }

  throw new Error(`等待邮件超时 (${timeoutMs / 1000}s)`);
}

/** 从邮件内容中提取 OTP 验证码 */
export function extractOtpCode(message: MessageDetail): string {
  // 优先使用纯文本，如果只有 HTML 则先剥离标签
  let text = message.bodyText || '';
  if (!text && message.bodyHtml) {
    text = message.bodyHtml
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  if (!text) text = message.subject || '';

  logger.debug(`邮件全文(前300字): ${text.slice(0, 300)}`);

  // 匹配常见的 OTP 格式（先匹配高置信度，再匹配低置信度）
  const patterns = [
    // "XXXXXX is your ... code" 或 "your ... code is XXXXXX"
    /(?:is your|your).{0,30}(?:code|verification|验证码)\b[:\s]*(\d{4,8})/i,
    /(\d{4,8})\s+(?:is your|is the).{0,20}(?:code|sign up|verification)/i,
    // 关键词 + 数字
    /(?:verification|verify|code|otp|验证码|确认码|sign.?up\s*code)[:\s#]*(\d{4,8})/i,
    // 纯 6 位数字（高置信度）
    /\b(\d{6})\b/,
    // 兆底 4-8 位数字
    /\b(\d{4,8})\b/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      logger.success(`提取到验证码: ${match[1]}`);
      return match[1];
    }
  }

  throw new Error(
    `无法从邮件中提取验证码。邮件内容: ${text.slice(0, 200)}`,
  );
}

/** 带重试的验证码获取 */
export async function waitForOtp(mailboxId: string): Promise<string> {
  const message = await retry(
    () => waitForEmail(mailboxId),
    {
      maxRetries: 2,
      delay: 3000,
      onRetry: (_err, attempt) => {
        logger.warn(`等待邮件重试 ${attempt}...`);
      },
    },
  );

  return extractOtpCode(message);
}
