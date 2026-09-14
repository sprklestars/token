# Vercel v0 自动注册系统

全自动注册 Vercel 账号并生成 v0 API Key(`vcp_` 开头)的批量工具,带 Web 控制台。

临时邮箱收 OTP → 接码平台过手机验证 → 反检测浏览器走完注册与 Onboarding → REST API 产出 Key,全程无人工干预。

| 指标 | 数据(2026-09 实测) |
|------|---------------------|
| 单次注册耗时 | ~92 秒(含 Onboarding) |
| 单次成本 | **$0.1**(美国物理号) |
| 批量模式 | 串行 + 轮间随机冷却 8-20s,单批上限 50 |
| 反检测 | Patchright(CDP 隐身)+ 真人行为模拟 + 风控文案拦截 |

## 适用场景

- 需要**多个 v0 API Key** 做开发、测试、额度储备(单账号额度有限时轮换使用)
- 需要**批量产出后集中管理**:控制台可查看历史记录、成功率、成本、一键复制 Key
- 希望**无人值守跑批**:夜间挂机,失败自动记录、号码自动释放、余额不足自动终止

## 功能特性

- **三种运行模式**:单次 CLI / 零成本 API 自检(dry-run)/ Web 控制台批量
- **Web 控制台**(`npm run web`):
  - 批量启动/停止、进度条、实时日志终端(SSE 推送,与后端控制台同步)
  - 统计卡片:总注册数 / 成功 / 失败 / API Keys / 预估成本
  - 注册记录表格:邮箱、手机号、状态、API Key 点击复制、详情弹窗
  - 接码平台余额实时显示
- **工程保护**:
  - 余额预检(需求 × 1.5 余量,不足直接终止)
  - 孤儿激活清理(异常退出挂着的号自动取消退款)
  - 失败自动记录并继续,号码自动释放
  - 提交前输入校验(React 受控组件专用防护)
- **DNS 污染修复**:内置被污染域名 → 真实 IP 映射,Node 层 patch + 浏览器层 `--host-resolver-rules` 双保险,`.env` 可覆盖

## 工作流程(12 步)

```
创建临时邮箱 → 打开注册页 → 邮箱注册
→ 等 OTP 邮件 ═╗
              ╠ Promise.all 并行
购买美国手机号 ═╝
→ 填邮箱验证码 → 填手机号(键盘逐字+校验)→ 等短信 → 填短信验证码
→ 过 5 页 Onboarding → REST API 创建 v0 Key → 结果存 JSON
```

## 环境要求

- **Node.js ≥ 22**(内置 fetch,ESM)
- Chromium(首次运行自动提示安装,见下方安装步骤)
- [HeroSMS](https://sms.fudugeek.xyz/) 接码平台账号(需充值,美国号 $0.1/个)
- [Unsnow Mail](https://mail.unsnow.org/) 邮箱服务 API Key

## 快速开始

```bash
# 1. 安装依赖
npm install

# 2. 安装 Patchright 的 Chromium
node node_modules/patchright/cli.js install chromium

# 3. 配置环境变量(参考下方配置说明)
cp .env.example .env   # 或手动创建 .env

# 4. 零成本自检:验证邮箱/接码 API 连通性(不买号不花钱)
npm run dry-run

# 5a. 单次注册(弹出浏览器窗口,可全程观察)
npm start

# 5b. 或启动 Web 控制台批量注册
npm run web
# 打开 http://127.0.0.1:5174
```

## 配置说明(`.env`)

```ini
# Unsnow Mail 邮箱服务
EMAIL_API_KEY=um_xxx              # 必填
EMAIL_API_BASE=https://mail.unsnow.org

# HeroSMS 接码平台
SMS_TOKEN=xxx                     # 必填(控制台生成的 API token)
SMS_API_BASE=https://sms.fudugeek.xyz

# 浏览器
HEADLESS=false                    # 批量模式建议 false(headless 反检测较弱)

# 超时(毫秒)
EMAIL_POLL_TIMEOUT=120000
SMS_POLL_TIMEOUT=120000
PAGE_TIMEOUT=30000

# DNS 污染修复覆盖 (可选,默认映射已内置,格式 host:ip,host:ip)
# DNS_OVERRIDES=sms.fudugeek.xyz:1.2.3.4

# 代理 (可选;http://user:pass@host:port;启用后浏览器走代理出口注册,避免同 IP 批量触发风控)
# PROXY_URL=http://user:pass@gate.ipfoxy.io:58688
```

## 使用说明

### 单次注册(CLI)

```bash
npm start            # headed 模式,全程可观察
```

结束后在 `output/` 生成 `register_<时间戳>.json`,包含邮箱、手机号、Vercel session cookies、v0 API Key。

### Web 控制台(推荐)

```bash
npm run web          # 默认 127.0.0.1:5174,WEB_PORT=8080 可换端口
```

控制台操作路径:**输入数量(1-50)→ 可选 headless → 开始批量 → 观察实时日志 → 结束后自动刷新统计与记录**。

**注意**:批量运行期间弹出浏览器窗口属正常现象(headed 模式反检测更稳)。

### Web API(可供二次开发)

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/stats` | 统计汇总 |
| GET | `/api/registrations` | 注册记录列表 |
| GET | `/api/registrations/:file` | 单条详情 |
| GET | `/api/balance` | 接码平台余额(30s 缓存) |
| GET | `/api/proxy` | 代理状态(未启用/已启用/异常) |
| POST | `/api/batch/start` | 启动批量 `{count, headless}` |
| POST | `/api/batch/stop` | 停止批量(当前轮完成后生效) |
| GET | `/api/batch/status` | 批量状态/进度 |
| GET | `/api/logs` | SSE 实时日志 |

## 成本预估

| 数量 | 接码成本 | 耗时(串行,含冷却) |
|------|----------|---------------------|
| 1 个 | $0.1 | ~1.5 分钟 |
| 5 个 | $0.5 | ~10 分钟 |
| 50 个 | $5 | ~100 分钟 |

失败轮次的号码会自动取消(2 分钟窗口内不可取消的会自动过期退款)。

## 目录结构

```
src/
├── index.ts               CLI 入口(--dry-run / --headed / --browser)
├── orchestrator.ts        12 步注册编排
├── batch.ts               批量执行器(串行队列/停止/冷却/余额预检)
├── config.ts              .env 配置加载
├── browser/
│   ├── vercel.ts          注册页+Onboarding 全流程自动化
│   ├── v0-settings.ts     v0 设置页
│   └── launch.ts          浏览器启动抽象(反检测参数)
├── services/
│   ├── email.service.ts   Unsnow Mail(创建邮箱/轮询 OTP/多级正则提码)
│   ├── sms.service.ts     HeroSMS(买号/查码/SSE 余额/孤儿清理)
│   └── v0.service.ts      Vercel REST API 创建 token
├── utils/
│   ├── human.ts           真人行为模拟(humanClick/humanType/鼠标预热)
│   ├── stealth.ts         风控拦截文案检测
│   ├── dns-fix.ts         DNS 污染修复(lookup patch + host-resolver-rules)
│   ├── logger.ts          彩色日志 + 内存缓冲/SSE 订阅
│   ├── storage.ts         结果持久化
│   └── retry.ts           重试/睡眠
├── web/
    └── server.ts          Web 控制台服务(原生 http,零依赖)
public/
└── index.html             控制台前端(单文件)
output/                    注册结果 JSON(git 忽略)
```

## 常见问题

**Q: 启动后所有请求超时?**
本地 DNS 污染。项目已内置修复(`src/utils/dns-fix.ts`),若真实 IP 变化,用 `.env` 的 `DNS_OVERRIDES` 覆盖。

**Q: 买号后取消报 "购号后两分钟内不可取消"?**
平台规则,正常。挂着的号 20 分钟后会自动过期退款;下次启动时的孤儿清理也会处理。

**Q: 批量跑到一半连续失败?**
大概率是同 IP 触发 Vercel 风控(日志出现 "try a different sign up method")。立即停止,在 `.env` 配置 `PROXY_URL` 走代理出口后再跑。**无代理时建议单批 ≤ 5 个。**

**Q: 启动报 "代理认证被拒(407)"?**
`PROXY_URL` 凭证无效(密码错/流量尽/会话过期)。工具启动时会自动预检代理(含 DNS 污染域名的 DoH 解析),凭证无效直接报错防止空跑,到代理服务商控制台更新凭证后重试。

**Q: `npx tsc` / `npx playwright` 报找不到命令?**
若 node_modules 是从其他平台拷贝的,执行 `npm install` 重建;脚本调用用 `node node_modules/<pkg>/...` 直连方式。

## 相关文档

- [TECHNICAL_DESIGN.md](./TECHNICAL_DESIGN.md) — 技术方案(架构 / 反检测设计 / 速度与成本分析)
- [v0-api-guide.md](./v0-api-guide.md) — 产出的 Key 如何调用 v0 API(支持指定模型)

## 免责声明

本项目仅供技术研究与学习自动化测试技术使用。使用者需自行承担因使用本工具产生的一切责任,请遵守目标网站的服务条款与当地法律法规。
