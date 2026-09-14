/**
 * 核心编排器 - 串联所有注册步骤
 *
 * 完整流程:
 *  1. 创建临时邮箱
 *  2. 浏览器打开 Vercel 注册页
 *  3. 选择邮箱注册 + 输入邮箱
 *  4. 等待并提取邮箱验证码
 *  5. 输入邮箱验证码
 *  6. 登录接码平台 + 获取美国手机号
 *  7. 输入手机号
 *  8. 等待并提取短信验证码
 *  9. 输入短信验证码
 * 10. 等待注册完成
 * 11. 导航到 v0 设置页创建 API Key
 * 12. 存储所有结果
 */

import type { Browser } from 'patchright';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { sleep } from './utils/retry.js';
import { saveResult, type RegistrationResult } from './utils/storage.js';
import { createMailbox, waitForOtp } from './services/email.service.js';
import { smsClient } from './services/sms.service.js';
import { createVercelToken } from './services/v0.service.js';
import { VercelBrowser } from './browser/vercel.js';

const TOTAL_STEPS = 12;

export async function runRegistration(browser: Browser, enableScreenshots = false): Promise<RegistrationResult> {
  const result: RegistrationResult = {
    timestamp: new Date().toISOString(),
    email: { address: '', mailboxId: '' },
    phone: { number: '', activationId: 0, country: '' },
    vercel: { registered: false },
    v0: { created: false },
    screenshots: [],
  };

  // 接码激活 ID，用于失败时取消
  let smsActivationId: number | null = null;

  const vercelBrowser = new VercelBrowser(browser, enableScreenshots);

  try {
    // ─── 初始化浏览器 ───
    await vercelBrowser.init();

    // ─── Step 1: 创建临时邮箱 ───
    logger.step(1, TOTAL_STEPS, '创建临时邮箱');
    const mailbox = await createMailbox();
    result.email = { address: mailbox.address, mailboxId: mailbox.id };

    // ─── Step 2: 打开注册页 ───
    logger.step(2, TOTAL_STEPS, '打开 Vercel 注册页');
    await vercelBrowser.navigateToSignup();

    // ─── Step 3: 选择邮箱注册 + 输入邮箱 ───
    logger.step(3, TOTAL_STEPS, '选择邮箱注册并输入地址');
    await vercelBrowser.selectEmailSignup();
    await vercelBrowser.enterEmail(mailbox.address);

    // ─── Step 4+6 并行: 等 OTP 邮件 + 同时购买手机号 ───
    logger.step(4, TOTAL_STEPS, '等待邮箱验证码 + 购买手机号 (并行)');

    // 并行启动: 等待 OTP 邮件 + SMS 登录购买号码
    const [emailOtp, smsPurchase] = await Promise.all([
      // 等 OTP
      waitForOtp(mailbox.id),
      // 同时买手机号
      (async () => {
        await smsClient.login();
        const tc = await smsClient.findCheapestVercelCountry();
        logger.info(`选择国家: ${tc.name} (ID: ${tc.id}, $${tc.price})`);
        const act = await smsClient.buyPhoneNumber(tc.id, tc.serviceCode);
        return { activation: act, targetCountry: tc };
      })(),
    ]);

    logger.success(`邮箱验证码: ${emailOtp}`);
    smsActivationId = smsPurchase.activation.activationId;
    result.phone = {
      number: smsPurchase.activation.phoneNumber,
      activationId: smsPurchase.activation.activationId,
      country: smsPurchase.targetCountry.name,
    };
    logger.success(`手机号已就绪: ${smsPurchase.activation.phoneNumber}`);

    // ─── Step 5: 输入邮箱验证码 ───
    logger.step(5, TOTAL_STEPS, '输入邮箱验证码');
    await vercelBrowser.enterEmailOtp(emailOtp);

    // ─── Step 7: 输入手机号 ───
    logger.step(7, TOTAL_STEPS, '输入手机号');
    await vercelBrowser.selectPhoneCountry(smsPurchase.targetCountry.name);
    await vercelBrowser.enterPhoneNumber(smsPurchase.activation.phoneNumber, smsPurchase.targetCountry.phoneCode);

    // ─── Step 8: 等待短信验证码 ───
    logger.step(8, TOTAL_STEPS, '等待短信验证码');
    await sleep(1500); // 等待短信发送
    const smsCode = await smsClient.waitForSmsCode(smsPurchase.activation.activationId);
    logger.success(`短信验证码: ${smsCode}`);

    // ─── Step 9: 输入短信验证码 ───
    logger.step(9, TOTAL_STEPS, '输入短信验证码');
    await vercelBrowser.enterSmsCode(smsCode);

    // ─── Step 10: 等待注册完成 ───
    logger.step(10, TOTAL_STEPS, '等待注册完成');
    await vercelBrowser.waitForDashboard();
    result.vercel.registered = true;
    result.vercel.authCookies = await vercelBrowser.getAuthCookies();

    // 完成接码激活
    try {
      await smsClient.finishActivation(smsPurchase.activation.activationId);
    } catch {
      logger.warn('完成接码激活失败（非致命）');
    }
    smsActivationId = null;

    logger.success('Vercel 注册成功!');

    // ─── Step 11: 创建 v0 API Key (直接用 REST API，跳过浏览器) ───
    logger.step(11, TOTAL_STEPS, '创建 v0 API Key');
    const token = await createVercelToken(vercelBrowser.getContext());
    if (token) {
      result.v0 = { apiKey: token, created: true };
    } else {
      logger.warn('v0 API Key 创建失败');
      result.v0 = { created: false };
    }

    // ─── Step 12: 存储结果 ───
    logger.step(12, TOTAL_STEPS, '存储注册结果');
    result.screenshots = vercelBrowser.screenshotPaths;
    const filepath = await saveResult(result);
    logger.success(`结果已保存: ${filepath}`);

    return result;
  } catch (error) {
    // 失败时取消接码激活，释放号码
    if (smsActivationId !== null) {
      try {
        await smsClient.cancelActivation(smsActivationId);
        logger.info('已释放接码号码');
      } catch {
        logger.warn('释放接码号码失败');
      }
    }

    result.screenshots = vercelBrowser.screenshotPaths;

    // 尝试保存错误状态
    try {
      const filepath = await saveResult(result);
      logger.info(`错误状态已保存: ${filepath}`);
    } catch {
      // ignore
    }

    throw error;
  } finally {
    await vercelBrowser.close();
  }
}
