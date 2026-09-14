/**
 * 结果持久化 - 将注册结果存储为 JSON 文件
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface RegistrationResult {
  timestamp: string;
  email: {
    address: string;
    mailboxId: string;
  };
  phone: {
    number: string;
    activationId: number;
    country: string;
  };
  vercel: {
    registered: boolean;
    authCookies?: Record<string, string>;
  };
  v0: {
    apiKey?: string;
    created: boolean;
  };
  screenshots: string[];
}

const OUTPUT_DIR = join(process.cwd(), 'output');

export async function saveResult(result: RegistrationResult): Promise<string> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  const filename = `register_${Date.now()}.json`;
  const filepath = join(OUTPUT_DIR, filename);

  await writeFile(filepath, JSON.stringify(result, null, 2), 'utf-8');

  return filepath;
}
