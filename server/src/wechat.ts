import { createHash } from 'node:crypto';

export interface WechatAuthConfig {
  appId?: string;
  appSecret?: string;
  allowDevLogin: boolean;
  devOpenid?: string;
  timeoutMs?: number;
}

export interface WechatIdentity {
  openid: string;
  unionid?: string;
}

export class WechatAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WechatAuthError';
  }
}

export async function exchangeWechatCode(
  code: string,
  config: WechatAuthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<WechatIdentity> {
  const normalizedCode = code.trim();
  if (!normalizedCode || normalizedCode.length > 512) {
    throw new WechatAuthError('微信登录 code 无效');
  }

  const devOpenid = config.devOpenid?.trim();
  if (config.allowDevLogin && devOpenid) {
    return { openid: devOpenid };
  }

  if (!config.appId || !config.appSecret) {
    if (!config.allowDevLogin) {
      throw new WechatAuthError('服务端未配置微信登录');
    }
    // 开发身份不保存原始 code，也不会在生产环境启用。
    return {
      openid: `dev_${createHash('sha256').update(normalizedCode).digest('hex')}`,
    };
  }

  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', config.appId);
  url.searchParams.set('secret', config.appSecret);
  url.searchParams.set('js_code', normalizedCode);
  url.searchParams.set('grant_type', 'authorization_code');

  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
  }).catch(() => {
    throw new WechatAuthError('无法连接微信登录服务');
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new WechatAuthError('微信登录服务返回无效响应');
  }
  if (!response.ok || !payload || typeof payload !== 'object') {
    throw new WechatAuthError('微信登录失败');
  }
  const result = payload as {
    openid?: unknown;
    unionid?: unknown;
    errcode?: unknown;
  };
  if (typeof result.errcode === 'number' && result.errcode !== 0) {
    // 不把微信 errmsg 原样透传，避免泄漏上游请求细节。
    throw new WechatAuthError(`微信登录失败 (${result.errcode})`);
  }
  if (typeof result.openid !== 'string' || !result.openid) {
    throw new WechatAuthError('微信登录响应缺少 openid');
  }
  return {
    openid: result.openid,
    ...(typeof result.unionid === 'string' && result.unionid
      ? { unionid: result.unionid }
      : {}),
  };
}
