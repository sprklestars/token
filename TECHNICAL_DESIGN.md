# Vercel v0 自动注册系统 — 技术方案

## 1. 整体架构

### 邮箱服务 — Unsnow Mail

用的 Unsnow Mail 的临时邮箱 API（`https://mail.unsnow.org`），每次注册前调接口创建一个随机邮箱地址，用来接收 Vercel 发过来的 OTP 验证码。

认证方式是 Bearer Token，响应格式是 Hydra（`hydra:member` 数组），流程就是：创建邮箱 → 轮询收件箱 → 拿到邮件内容 → 正则提取验证码。

验证码提取用了多级正则：先匹配 `code: XXXXXX` 这种带关键词的格式，匹配不到再 fallback 到纯 6 位数字，主要是为了避免把邮件里的年份（比如 2026）误识别成验证码——这个坑实际踩过。

### 接码平台 — HeroSMS

用的 HeroSMS（`https://sms.fudugeek.xyz`），通过逆向它的前端 JS 拿到了完整的 30 多个 API 端点。认证是 POST `/api/login` 拿 Session Cookie，后续请求自动带上。

Vercel 在它上面的服务代码是 `amb`，支持 3 个国家：美国 $1.25、英国 $0.10、印尼 $0.10。实测英国和印尼出的都是 VoIP 虚拟号，Vercel 直接拒绝，只有美国的物理号能稳定通过验证。美国 country ID 是 187。

流程：登录 → 查国家/服务 → 买号码 → 轮询短信 → 拿到验证码。

### 自动化浏览器 — Patchright

用的 Patchright，是 Playwright 的一个反检测 fork。Vercel 用了 Kasada 做反 bot，它主要检测 Playwright/Puppeteer 在 CDP 协议层的 `Runtime.enable` 调用泄漏。

试过几个方案：
- 标准 Playwright — 直接被 Kasada 拦
- Camoufox（Firefox 内核）— 反检测最强，但跟 Cloudflare CDN 有 HTTP/2 协议兼容问题，页面直接报 Network Protocol Error
- rebrowser-patches — CDP 补丁不够深，提交后被 Kasada crash
- Patchright — 专门修了 `Runtime.enable` 泄漏，实测稳定通过

最终选了 Patchright。不需要额外注入隐身脚本（加了反而可能被 Kasada 识别到脚本注入行为），启动参数只加了 `--disable-blink-features=AutomationControlled` 和 `--disable-http2`。

### 反检测设计

分三层做：

**浏览器层**：靠 Patchright 本身修 CDP 泄漏，不额外加料。

**行为层** (`human.ts`)：让操作看起来像真人。
- 点击不是直接 `click()`，而是鼠标先移到元素内随机位置，按下，随机按住一段时间再松开（`humanClick`）。这里有个大坑：Playwright 原生的 `click()` 触发不了 Next.js 的 React 状态更新，必须用 humanClick 这种模拟真实鼠标事件的方式才行。
- 输入框不是 `fill()` 一步到位，而是先聚焦、全选、删除、再填入，模拟粘贴操作。
- 验证码是逐格点击输入框再逐字 `keyboard.press`。
- 每个操作之间有随机停顿，0.5-2.5 秒不等。
- 页面加载后会做鼠标移动+滚动的预热序列，让 Next.js 认为是真人。

**风控层** (`stealth.ts`)：
- 提交后检查页面有没有出现 "try a different sign up method" 这种硬拦截文案，有就直接终止流程。
- 邮箱 OTP 提取的多级正则防止误匹配。
- SMS 轮询 2 秒间隔，120 秒超时。

## 2. 注册全流程

| # | 操作 | 说明 |
|---|------|------|
| 1 | 创建临时邮箱 | 调 Unsnow Mail API |
| 2 | 打开 Vercel 注册页 | Patchright 打开 `/signup`，做鼠标预热 |
| 3 | 点 Continue with Email | humanClick（原生 click 触发不了 React） |
| 4 | 等 OTP + 买手机号 | **Promise.all 并行**，省了约 4 秒 |
| 5 | 填入邮箱 OTP | 逐格填入 6 位验证码 |
| 6 | 填手机号 | Vercel 默认美国，不用选国家，去掉 +1 前缀直接输号码 |
| 7 | 等短信验证码 | HeroSMS 轮询，通常 1-3 秒就到 |
| 8 | 填入短信验证码 | 逐格填入 4 位码 |
| 9 | 过 onboarding | 5 个页面自动处理：使用意图→角色→团队规模→构建内容→选计划+填团队名 |
| 10 | 创建 v0 API Key | 直接调 Vercel REST API（`POST /v3/user/tokens`），用 session cookie 认证，拿到 `vcp_` 开头的 token |
| 11 | 存结果 | 输出 JSON（邮箱、手机号、Vercel 状态、API Key） |

onboarding 的 5 个页面分别是：
- "How do you plan to use Vercel?" → 选 Personal
- "What best describes your role?" → 选 Developer
- "How big is your team?" → 选 Just me
- "What are you building?" → JS 点击 chip 按钮 + 点 Done（这页是 chip 不是 checkbox，得用 JS click）
- "Choose a plan" → 选 "I'm working on personal projects"（用 substring 匹配，因为这行有撇号，精确匹配会失败），再填随机团队名

## 3. 速度分析

单次注册 **54 秒**，从最初的 170 秒压下来的。

**耗时拆解**：

| 阶段 | 耗时 | 可控? |
|------|------|-------|
| 浏览器启动 | ~2s | 否 |
| 邮箱创建 | ~2s | 否（API 响应） |
| 页面加载 + 预热 | ~5s | 部分 |
| 点击 + 填邮箱 + 提交 | ~4s | 是 |
| 等 OTP 邮件 | ~5-10s | 否（Vercel 发邮件速度） |
| OTP 填入 + 提交 | ~4s | 是 |
| 买手机号 | 跟 OTP 并行，不额外耗时 | — |
| 填手机号 + 提交 | ~3s | 是 |
| 等短信 | ~1-3s | 否（HeroSMS 速度） |
| SMS 填入 + 提交 | ~3s | 是 |
| Onboarding 5 页 | ~15s | 是 |
| v0 Key 创建 | ~1s | 否（API 响应） |

**做过的优化**：

| 优化项 | 省了多少 |
|--------|---------|
| OTP 等待 + 手机号购买改 Promise.all 并行 | -4s |
| 截图默认关闭 | -4s |
| 所有 sleep 间隔砍到最低安全值 | -12s |
| 美国号跳过国家选择（Vercel 默认就是美国） | -2s |
| v0 Key 创建不走浏览器，直接 REST API | -18s |
| **合计** | **-40s** |

不可控的部分（网络延迟、API 响应、Vercel 发邮件）大约占 20 秒，这部分没法再压了。

## 4. 成本分析

| 项目 | 单次成本 | 说明 |
|------|---------|------|
| HeroSMS 美国手机号 | **$1.25** | 物理号，唯一可用选项 |
| Unsnow Mail 临时邮箱 | 包含在套餐内 | 无额外费用 |
| Patchright 浏览器 | 免费 | 开源 |
| Vercel REST API | 免费 | 注册后即可调用 |
| **单次注册总成本** | **$1.25** | |

英国和印尼的号虽然只要 $0.10（便宜 12.5 倍），但都是 VoIP 虚拟号，Vercel 直接拒绝，用不了。

如果后续批量注册 50 个账号，接码成本约 50 × $1.25 = **$62.5**。
