/**
 * Web 控制台服务 - 原生 http 实现 (零依赖)
 *
 * 路由:
 *   GET  /                     前端页面 (public/index.html)
 *   GET  /api/stats            统计汇总
 *   GET  /api/registrations    注册记录列表
 *   GET  /api/registrations/:f 单条详情 (register_*.json)
 *   GET  /api/balance          接码平台余额 (30s 缓存)
 *   POST /api/batch/start      启动批量 {count, headless}
 *   POST /api/batch/stop       停止批量
 *   GET  /api/batch/status     批量状态
 *   GET  /api/logs             SSE 实时日志
 *
 * 用法: npm run web  (默认 http://127.0.0.1:5174,可用 WEB_PORT 覆盖)
 */

// DNS 污染修复必须在所有网络请求之前加载(副作用: patch dns.lookup)
import '../utils/dns-fix.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { logger, subscribeLogs, getRecentLogs } from '../utils/logger.js';
import { smsClient } from '../services/sms.service.js';
import { batchRunner } from '../batch.js';
import { getProxy } from '../browser/launch.js';
import { config } from '../config.js';
import type { RegistrationResult } from '../utils/storage.js';

const PORT = Number(process.env.WEB_PORT || 5174);
const HOST = '127.0.0.1';
const OUTPUT_DIR = join(process.cwd(), 'output');
const PUBLIC_DIR = join(process.cwd(), 'public');

/** 余额缓存 (避免频繁登录/连 SSE;批量运行期间只用缓存,防止 session 被顶掉) */
let balanceCache: { value: number | null; at: number } | null = null;

// ── 工具函数 ──

function json(res: ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

/** 读取全部注册记录 (按文件名时间戳倒序) */
async function readRegistrations(): Promise<Array<{ file: string; data: RegistrationResult }>> {
  try {
    const files = (await readdir(OUTPUT_DIR))
      .filter((f) => /^register_\d+\.json$/.test(f))
      .sort()
      .reverse();
    const out: Array<{ file: string; data: RegistrationResult }> = [];
    for (const f of files) {
      try {
        const text = await readFile(join(OUTPUT_DIR, f), 'utf-8');
        out.push({ file: f, data: JSON.parse(text) });
      } catch { /* 跳过损坏文件 */ }
    }
    return out;
  } catch {
    return [];
  }
}

// ── HTTP 服务 ──

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${HOST}`);
  const path = url.pathname;

  try {
    // 静态前端
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // SSE 实时日志
    if (req.method === 'GET' && path === '/api/logs') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // 连接后先推历史日志,再实时订阅
      for (const entry of getRecentLogs(150)) {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      }
      const unsubscribe = subscribeLogs((entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        unsubscribe();
        clearInterval(heartbeat);
      });
      return; // 连接保持打开
    }

    // 代理状态(前端徽章显示用)
    if (req.method === 'GET' && path === '/api/proxy') {
      if (!config.proxy.url) {
        return json(res, { configured: false, status: 'off', server: null });
      }
      try {
        const proxy = await getProxy();
        if (proxy) {
          return json(res, { configured: true, status: 'ok', server: proxy.server });
        }
        // 配置了但解析为 null(格式错误等),getProxy 会返回 null 而不抛错
        return json(res, { configured: true, status: 'error', server: null, error: 'PROXY_URL 解析失败' });
      } catch (e) {
        return json(res, {
          configured: true,
          status: 'error',
          server: null,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }

    // 统计汇总
    if (req.method === 'GET' && path === '/api/stats') {
      const regs = await readRegistrations();
      const total = regs.length;
      const success = regs.filter((r) => r.data.vercel?.registered).length;
      const apiKeys = regs.filter((r) => r.data.v0?.created).length;
      // 预估成本: 每个成功注册消耗一个 $0.1 美国号
      const cost = Number((success * 0.1).toFixed(2));
      return json(res, { total, success, failed: total - success, apiKeys, cost });
    }

    // 注册记录列表
    if (req.method === 'GET' && path === '/api/registrations') {
      const regs = await readRegistrations();
      return json(res, regs.map(({ file, data }) => ({
        file,
        timestamp: data.timestamp,
        email: data.email?.address ?? '',
        phone: data.phone?.number ?? '',
        country: data.phone?.country ?? '',
        registered: !!data.vercel?.registered,
        apiKey: data.v0?.apiKey ?? null,
        keyCreated: !!data.v0?.created,
      })));
    }

    // 单条详情 (文件名严格校验,防路径穿越)
    const detailMatch = path.match(/^\/api\/registrations\/(register_\d+\.json)$/);
    if (req.method === 'GET' && detailMatch) {
      try {
        const text = await readFile(join(OUTPUT_DIR, detailMatch[1]), 'utf-8');
        return json(res, JSON.parse(text));
      } catch {
        return json(res, { error: 'NOT_FOUND' }, 404);
      }
    }

    // 接码平台余额
    if (req.method === 'GET' && path === '/api/balance') {
      const running = batchRunner.getStatus().running;
      if (balanceCache && (Date.now() - balanceCache.at < 30_000 || running)) {
        return json(res, { balance: balanceCache.value });
      }
      try {
        await smsClient.login();
        const { balance } = await smsClient.getSnapshot();
        balanceCache = { value: balance, at: Date.now() };
        return json(res, { balance });
      } catch (e) {
        // 余额查询失败不炸页面
        return json(res, { balance: null, error: String(e) });
      }
    }

    // 批量控制
    if (req.method === 'POST' && path === '/api/batch/start') {
      let body: { count?: number; headless?: boolean } = {};
      try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* 空 body */ }
      const count = Math.max(1, Math.min(50, Number(body.count) || 1));
      if (batchRunner.getStatus().running) {
        return json(res, { error: '批量任务已在运行中' }, 409);
      }
      await batchRunner.start(count, !!body.headless);
      return json(res, { ok: true, count });
    }

    if (req.method === 'POST' && path === '/api/batch/stop') {
      return json(res, { ok: batchRunner.requestStop() });
    }

    if (req.method === 'GET' && path === '/api/batch/status') {
      return json(res, batchRunner.getStatus());
    }

    json(res, { error: 'NOT_FOUND', path }, 404);
  } catch (e) {
    logger.error(`Web 请求处理失败 ${path}: ${e}`);
    json(res, { error: String(e) }, 500);
  }
});

server.listen(PORT, HOST, () => {
  logger.success(`Web 控制台已启动: http://${HOST}:${PORT}`);
});
