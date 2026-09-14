/**
 * HeroSMS 接码平台 API 封装
 *
 * Base URL: https://sms.fudugeek.xyz
 * 认证: POST /api/login -> httpOnly Session Cookie
 * API 通过逆向前端 JS 分析获得
 *
 * 2026-09-08 平台 API 改版适配:
 * - /api/offers 已下线 → /api/prices?service=X&country=Y 按需查询
 * - /api/buy 响应字段 phoneNumber/activationId → phone/id/cost
 * - /api/otp 已下线 → /api/status?id=X 查询短信
 * - 新增 /api/stream (SSE) 实时推送余额与激活列表
 */

import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/retry.js';

interface Country {
  id: number;
  name: string;
  eng: string;
  rent: boolean;
}

interface Service {
  code: string;
  name: string;
}

interface Activation {
  phoneNumber: string;
  activationId: number;
}

/** /api/status?id=X 返回的激活状态(含短信内容) */
interface ActivationStatus {
  sms: Array<{ code?: string; text?: string; at?: string }>;
  call?: { from?: string; code?: string; text?: string; at?: string };
}

/** /api/prices?service=X&country=Y 返回的报价条目 */
interface PriceRow {
  service: string;
  country: number;
  cost: number;
  count: number;
}

/** /api/stream (SSE) 推送的激活条目 */
interface StreamActivation {
  id: number;
  phone: string;
  service: string;
  country: number;
  status: number;
  statusText: string;
  price: number;
  codes: string[];
  startedAt: number;
  expiresAt: number;
}

const BASE = config.sms.baseUrl;

/** 接码平台 HTTP 客户端（管理 session cookie） */
class SmsClient {
  private cookies: string[] = [];

  private async request<T>(
    path: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${BASE}${path}`;
    const headers = new Headers(options.headers);

    // 只有带 body 的请求才设置 Content-Type
    if (options.body) {
      headers.set('Content-Type', 'application/json');
    }

    if (this.cookies.length > 0) {
      headers.set('Cookie', this.cookies.join('; '));
    }

    const res = await fetch(url, {
      ...options,
      headers,
      redirect: 'manual',
    });

    // 保存 Set-Cookie
    const setCookies = res.headers.getSetCookie?.() ?? [];
    if (setCookies.length > 0) {
      this.cookies = setCookies.map((c) => c.split(';')[0]);
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`SMS API ${path} 失败: ${res.status} ${body}`);
    }

    if (res.status === 204) return undefined as T;

    const text = await res.text();
    return text ? JSON.parse(text) : undefined as T;
  }

  /** 登录获取 session */
  async login(): Promise<void> {
    logger.info('登录接码平台...');
    await this.request('/api/login', {
      method: 'POST',
      body: JSON.stringify({ token: config.sms.token }),
    });
    logger.success('接码平台登录成功');
  }

  /** 检查登录状态 */
  async me(): Promise<{ ok: boolean }> {
    return this.request('/api/me');
  }

  /** 获取所有国家列表 */
  async getCountries(): Promise<Country[]> {
    return this.request('/api/countries');
  }

  /** 获取所有服务列表 */
  async getServices(): Promise<Service[]> {
    return this.request('/api/services');
  }

  /** 查找美国的 country ID (精确匹配 USA 物理号,排除 "USA (2)" 等虚拟号) */
  async findUsCountryId(): Promise<number> {
    const countries = await this.getCountries();
    const us = countries.find(
      (c) => c.eng === 'USA' || c.eng === 'United States' || c.name === '美国',
    );
    if (!us) throw new Error('找不到美国 (United States) 的国家 ID');
    logger.info(`美国 country ID: ${us.id} (${us.eng})`);
    return us.id;
  }

  /** 查找 Vercel 服务最便宜且可用的国家（优先英国 > 印尼 > 美国） */
  async findCheapestVercelCountry(): Promise<{
    id: number; name: string; serviceCode: string; price: number; phoneCode: number;
  }> {
    const countries = await this.getCountries();
    const vercelCode = await this.findVercelServiceCode();

    // 已知国家的国际区号
    const phoneCodes: Record<string, number> = {
      'united kingdom': 44, 'uk': 44,
      'indonesia': 62,
      'united states': 1, 'usa': 1,
    };

    // 优先级: 美国 > 英国 > 印尼 (美国物理号稳定可用，UK/印尼的 VoIP 号被 Vercel 拒绝)
    // 注意精确匹配 eng 字段: 模糊匹配会把 "USA (2)"(虚拟号)、"Ukraine" 等误选中
    const priorities = [
      { match: (c: Country) => c.eng === 'USA' || c.eng === 'United States' || c.name === '美国', name: 'United States' },
      { match: (c: Country) => c.eng === 'United Kingdom' || c.name === '英国', name: 'United Kingdom' },
      { match: (c: Country) => c.eng === 'Indonesia' || c.name === '印尼', name: 'Indonesia' },
    ];

    for (const prio of priorities) {
      const country = countries.find(prio.match);
      if (!country) continue;

      // 按国家查报价 (新端点支持 service+country 过滤,几百字节,无需拉全量表)
      const rows = await this.request<PriceRow[]>(
        `/api/prices?service=${vercelCode}&country=${country.id}`,
      );
      const offer = rows[0];
      const price = offer?.cost || 0;
      const totalNumbers = offer?.count || 0;

      if (totalNumbers > 0) {
        const phoneCode = phoneCodes[country.eng.toLowerCase()] || 1;
        logger.info(`选择国家: ${country.eng} (ID: ${country.id}, $${price}, ${totalNumbers}个号码)`);
        return {
          id: country.id,
          name: country.eng,
          serviceCode: vercelCode,
          price,
          phoneCode,
        };
      }
    }

    throw new Error('找不到可用的 Vercel 接码国家');
  }

  /** 查找 Vercel 对应的 service code */
  async findVercelServiceCode(): Promise<string> {
    const services = await this.getServices();

    // 尝试多种匹配方式
    const vercel = services.find(
      (s) =>
        s.name.toLowerCase().includes('vercel') ||
        s.code.toLowerCase().includes('vercel'),
    );

    if (!vercel) {
      // 如果找不到 Vercel，尝试 "any" 或其他通用服务
      logger.warn('未找到 Vercel 专属服务，将尝试通用服务');
      const any = services.find(
        (s) =>
          s.name.toLowerCase().includes('any') ||
          s.code === 'any' ||
          s.name.toLowerCase().includes('other'),
      );
      if (any) return any.code;
      throw new Error(
        `找不到 Vercel 或通用服务。可用服务: ${services.slice(0, 20).map((s) => s.name).join(', ')}...`,
      );
    }

    logger.info(`Vercel service code: ${vercel.code} (${vercel.name})`);
    return vercel.code;
  }

  /** 购买号码 (新 API 响应 {phone, id, cost},映射到对外兼容的字段名) */
  async buyPhoneNumber(countryId: number, serviceCode: string): Promise<Activation> {
    logger.info(`购买号码: country=${countryId}, service=${serviceCode}`);

    const raw = await this.request<{ phone: string; id: number; cost?: number }>('/api/buy', {
      method: 'POST',
      body: JSON.stringify({
        service: serviceCode,
        country: countryId,
      }),
    });

    const result: Activation = { phoneNumber: raw.phone, activationId: raw.id };
    logger.success(
      `号码已获取: ${result.phoneNumber} (ID: ${result.activationId}${raw.cost != null ? `, $${raw.cost}` : ''})`,
    );
    return result;
  }

  /** 查询单个激活的短信状态 (新端点 /api/status?id=X) */
  async getStatus(activationId: number): Promise<ActivationStatus> {
    return this.request(`/api/status?id=${activationId}`);
  }

  /** 轮询等待短信验证码 */
  async waitForSmsCode(
    activationId: number,
    timeoutMs: number = config.timeout.smsPoll,
  ): Promise<string> {
    logger.info(`等待短信验证码 (超时 ${timeoutMs / 1000}s)...`);

    const startTime = Date.now();
    const pollInterval = 3000;

    while (Date.now() - startTime < timeoutMs) {
      const status = await this.getStatus(activationId);
      const code = status?.sms?.[0]?.code;

      if (code) {
        logger.success(`收到验证码: ${code}`);
        return code;
      }

      logger.debug('暂无短信，继续轮询...');
      await sleep(pollInterval);
    }

    throw new Error(`等待短信验证码超时 (${timeoutMs / 1000}s)`);
  }

  /** 取消激活（释放号码） */
  async cancelActivation(activationId: number): Promise<void> {
    logger.info(`取消激活: ${activationId}`);
    await this.request('/api/cancel', {
      method: 'POST',
      body: JSON.stringify({ id: activationId }),
    });
    logger.success('激活已取消');
  }

  /** 完成激活 */
  async finishActivation(activationId: number): Promise<void> {
    logger.info(`完成激活: ${activationId}`);
    await this.request('/api/finish', {
      method: 'POST',
      body: JSON.stringify({ id: activationId }),
    });
    logger.success('激活已完成');
  }

  /** 连接 SSE /api/stream 读取一条快照 (余额 + 当前激活列表),读完即断开 */
  async getSnapshot(timeoutMs = 10000): Promise<{ balance: number | null; activations: StreamActivation[] }> {
    const res = await fetch(`${BASE}/api/stream`, {
      headers: { Cookie: this.cookies.join('; '), Accept: 'text/event-stream' },
    });
    if (!res.ok || !res.body) {
      throw new Error(`SSE 连接失败: ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const deadline = Date.now() + timeoutMs;

    try {
      let buf = '';
      while (Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('SSE 读取超时')), deadline - Date.now()),
          ),
        ]);
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        for (const line of buf.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          try {
            const d = JSON.parse(payload) as { balance?: number; activations?: StreamActivation[] };
            if (Array.isArray(d.activations)) {
              return { balance: d.balance ?? null, activations: d.activations };
            }
          } catch { /* 忽略非 JSON 行 */ }
        }
        buf = buf.slice(buf.lastIndexOf('\n') + 1);
      }
      throw new Error('SSE 未推送激活列表');
    } finally {
      await reader.cancel().catch(() => {});
    }
  }

  /** 清理孤儿激活 (上次异常退出挂着的号),返回成功取消的数量 */
  async recoverOrphanActivations(): Promise<number> {
    try {
      const { balance, activations } = await this.getSnapshot();
      if (balance != null) logger.info(`接码平台余额: $${balance.toFixed(2)}`);
      if (activations.length === 0) return 0;

      let recovered = 0;
      logger.warn(`发现 ${activations.length} 个孤儿激活,正在取消...`);
      for (const a of activations) {
        try {
          await this.cancelActivation(a.id);
          recovered++;
        } catch (e) {
          // 新平台规则: 购号后 2 分钟内不可取消,到期未收到验证码会自动过期释放
          logger.warn(`取消孤儿激活 ${a.id} 失败(将自动过期): ${e}`);
        }
      }
      return recovered;
    } catch (e) {
      logger.warn(`孤儿激活检查失败(非致命): ${e}`);
      return 0;
    }
  }
}

export const smsClient = new SmsClient();
export type { Country, Service, Activation, ActivationStatus, StreamActivation };
