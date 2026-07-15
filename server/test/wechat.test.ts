import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { exchangeWechatCode } from '../src/wechat.js';

describe('开发微信登录', () => {
  it('允许开发工具指定固定的本地身份', async () => {
    await expect(
      exchangeWechatCode('temporary-code', {
        allowDevLogin: true,
        devOpenid: 'belong-dev-owner',
      }),
    ).resolves.toEqual({ openid: 'belong-dev-owner' });
  });

  it('未指定身份时仍按临时 code 映射不同用户', async () => {
    const code = 'temporary-code';
    await expect(exchangeWechatCode(code, { allowDevLogin: true })).resolves.toEqual({
      openid: `dev_${createHash('sha256').update(code).digest('hex')}`,
    });
  });
});
