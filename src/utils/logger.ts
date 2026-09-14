/**
 * 带颜色的日志输出工具 + 内存缓冲/订阅 (供 Web 控制台 SSE 推送)
 */

const C = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
} as const;

export interface LogEntry {
  time: string;
  level: 'info' | 'success' | 'warn' | 'error' | 'step' | 'debug';
  msg: string;
}

const MAX_BUFFER = 500;
const buffer: LogEntry[] = [];
const subscribers = new Set<(entry: LogEntry) => void>();

/** 写入缓冲并广播给订阅者(Web SSE 用) */
function emit(level: LogEntry['level'], msg: string, args: unknown[]): void {
  const entry: LogEntry = {
    time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
    level,
    msg: args.length > 0 ? [msg, ...args].map(String).join(' ') : msg,
  };
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  for (const fn of subscribers) {
    try { fn(entry); } catch { /* 订阅者异常不影响主流程 */ }
  }
}

function ts(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/** 订阅实时日志,返回取消订阅函数 */
export function subscribeLogs(fn: (entry: LogEntry) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** 获取最近的日志(内存缓冲) */
export function getRecentLogs(n = 200): LogEntry[] {
  return buffer.slice(-n);
}

export const logger = {
  info(msg: string, ...args: unknown[]) {
    console.log(
      `${C.gray}[${ts()}]${C.reset} ${C.blue}INFO${C.reset}  ${msg}`,
      ...args,
    );
    emit('info', msg, args);
  },
  success(msg: string, ...args: unknown[]) {
    console.log(
      `${C.gray}[${ts()}]${C.reset} ${C.green}  OK${C.reset}    ${msg}`,
      ...args,
    );
    emit('success', msg, args);
  },
  warn(msg: string, ...args: unknown[]) {
    console.warn(
      `${C.gray}[${ts()}]${C.reset} ${C.yellow}WARN${C.reset}  ${msg}`,
      ...args,
    );
    emit('warn', msg, args);
  },
  error(msg: string, ...args: unknown[]) {
    console.error(
      `${C.gray}[${ts()}]${C.reset} ${C.red}ERROR${C.reset}   ${msg}`,
      ...args,
    );
    emit('error', msg, args);
  },
  step(step: number, total: number, msg: string) {
    console.log(
      `${C.gray}[${ts()}]${C.reset} ${C.cyan}[${step}/${total}]${C.reset}  ${C.bold}${msg}${C.reset}`,
    );
    emit('step', `[${step}/${total}] ${msg}`, []);
  },
  debug(msg: string, ...args: unknown[]) {
    if (process.env.DEBUG) {
      console.log(
        `${C.gray}[${ts()}]${C.reset} ${C.gray}DEBUG${C.reset}   ${msg}`,
        ...args,
      );
    }
    // debug 不进缓冲(太噪)
  },
};
