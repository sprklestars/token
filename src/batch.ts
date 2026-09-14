/**
 * 批量注册执行器 - 串行队列 + 停止控制 + 轮间随机延迟
 *
 * 设计要点:
 * - 串行执行(不并发): 同 IP 并发注册必然触发 Vercel 风控
 * - 每轮启动独立浏览器进程,轮间随机冷却 8-20s
 * - 启动前做余额检查,余额不足直接终止
 * - 失败自动记录并继续下一轮(runRegistration 内部已处理号码释放)
 */

import { runRegistration } from './orchestrator.js';
import { launchChromium } from './browser/launch.js';
import { smsClient } from './services/sms.service.js';
import { logger } from './utils/logger.js';
import { sleep } from './utils/retry.js';

/** 美国号单价 (country 187, 2026-09 实测) */
const COST_PER_REGISTRATION = 0.1;
/** 单轮成本上限保护 */
const MAX_COUNT = 50;

export interface BatchItemResult {
  index: number;
  status: 'success' | 'failed';
  email?: string;
  phone?: string;
  apiKey?: string;
  error?: string;
  durationMs: number;
}

export interface BatchStatus {
  running: boolean;
  stopRequested: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  results: BatchItemResult[];
  startedAt: string | null;
  finishedAt: string | null;
  currentPhase: string;
}

class BatchRunner {
  private state: BatchStatus = this.idleState();
  /** 递增的运行代际,防止旧循环覆盖新任务状态 */
  private runId = 0;

  private idleState(): BatchStatus {
    return {
      running: false,
      stopRequested: false,
      total: 0,
      completed: 0,
      succeeded: 0,
      failed: 0,
      results: [],
      startedAt: null,
      finishedAt: null,
      currentPhase: '空闲',
    };
  }

  getStatus(): BatchStatus {
    return { ...this.state, results: [...this.state.results] };
  }

  /** 启动批量任务(异步执行,立即返回) */
  async start(count: number, headless: boolean): Promise<void> {
    if (this.state.running) throw new Error('批量任务已在运行中');
    const clamped = Math.max(1, Math.min(MAX_COUNT, count));
    const myRun = ++this.runId;

    this.state = {
      ...this.idleState(),
      running: true,
      total: clamped,
      startedAt: new Date().toISOString(),
      currentPhase: '前置检查',
    };

    // 异步执行主循环,不阻塞调用方(HTTP 响应)
    void this.runLoop(clamped, headless, myRun);
  }

  /** 请求停止(当前轮完成后生效) */
  requestStop(): boolean {
    if (!this.state.running || this.state.stopRequested) return false;
    this.state.stopRequested = true;
    logger.warn('已请求停止批量任务(当前轮完成后生效)');
    return true;
  }

  private async runLoop(count: number, headless: boolean, myRun: number): Promise<void> {
    logger.info(`═══ 批量注册启动: ${count} 个账号 (${headless ? 'headless' : 'headed'}) ═══`);
    try {
      // ── 前置: 登录接码平台 + 清理孤儿激活 + 余额检查 ──
      await smsClient.login();
      await smsClient.recoverOrphanActivations();
      const { balance } = await smsClient.getSnapshot();
      const needBudget = count * COST_PER_REGISTRATION * 1.5;
      if (balance != null && balance < needBudget) {
        throw new Error(`余额不足: $${balance.toFixed(2)} < 预估需求 $${needBudget.toFixed(2)}`);
      }
      if (balance != null) {
        logger.info(`余额 $${balance.toFixed(2)},预估消耗 ~$${(count * COST_PER_REGISTRATION).toFixed(2)}`);
      }

      // ── 主循环: 串行注册 ──
      for (let i = 1; i <= count; i++) {
        if (this.runId !== myRun) return; // 被新任务取代,放弃状态写入
        if (this.state.stopRequested) {
          logger.warn(`停止生效,已完成 ${this.state.completed}/${count}`);
          break;
        }

        this.state.currentPhase = `第 ${i}/${count} 个注册中`;
        logger.info(`───── 开始第 ${i}/${count} 个注册 ─────`);
        const startTime = Date.now();
        let browser = null;

        try {
          browser = await launchChromium(headless);
          const result = await runRegistration(browser, false);

          const item: BatchItemResult = {
            index: i,
            status: 'success',
            email: result.email.address,
            phone: result.phone.number,
            apiKey: result.v0.apiKey,
            durationMs: Date.now() - startTime,
          };
          this.state.results.push(item);
          this.state.succeeded++;
          logger.success(`第 ${i} 个注册成功: ${item.email} (${(item.durationMs / 1000).toFixed(1)}s)`);
        } catch (e) {
          const item: BatchItemResult = {
            index: i,
            status: 'failed',
            error: e instanceof Error ? e.message : String(e),
            durationMs: Date.now() - startTime,
          };
          this.state.results.push(item);
          this.state.failed++;
          logger.error(`第 ${i} 个注册失败: ${item.error}`);
        } finally {
          this.state.completed++;
          // runRegistration 内部会关浏览器,这里兜底幂等关闭
          if (browser) await browser.close().catch(() => {});
        }

        // ── 轮间随机冷却(防风控),最后一轮/已请求停止则跳过 ──
        if (i < count && !this.state.stopRequested && this.runId === myRun) {
          const delay = 8000 + Math.random() * 12000; // 8-20s
          this.state.currentPhase = `冷却 ${(delay / 1000).toFixed(0)}s 后开始第 ${i + 1} 个`;
          logger.info(`轮间冷却 ${(delay / 1000).toFixed(1)}s...`);
          await sleep(delay);
        }
      }
    } catch (e) {
      logger.error(`批量任务异常终止: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (this.runId === myRun) {
        this.state.running = false;
        this.state.finishedAt = new Date().toISOString();
        this.state.currentPhase = '空闲';
        const { completed, succeeded, failed, total } = this.state;
        logger.info(
          `═══ 批量任务结束: ${completed}/${total} 完成(成功 ${succeeded} / 失败 ${failed})═══`,
        );
      }
    }
  }
}

export const batchRunner = new BatchRunner();
