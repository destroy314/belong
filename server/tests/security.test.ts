import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startOfSessionDayMs } from '../src/config.js';
import { decryptSecret, encryptSecret, hashSessionToken } from '../src/security.js';

describe('BYOK 加密', () => {
  it('使用 AES-256-GCM 与家庭 AAD 封装 API Key', () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret('sk-private-value', key, 'family-llm:f1');
    expect(encrypted).not.toContain('sk-private-value');
    expect(decryptSecret(encrypted, key, 'family-llm:f1')).toBe('sk-private-value');
    expect(() => decryptSecret(encrypted, key, 'family-llm:f2')).toThrow();
  });

  it('会话令牌哈希后不保留原文', () => {
    const token = 'raw-session-token';
    const digest = hashSessionToken(token);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(token);
  });
});

describe('每日会话边界', () => {
  it('默认按 UTC+8 的凌晨四点计算', () => {
    const now = Date.parse('2026-07-14T12:34:56.000Z');
    expect(new Date(startOfSessionDayMs(now, 480, 4)).toISOString()).toBe(
      '2026-07-13T20:00:00.000Z',
    );
  });

  it('凌晨四点前仍归入前一天的会话', () => {
    const now = Date.parse('2026-07-13T19:59:59.000Z');
    expect(new Date(startOfSessionDayMs(now, 480, 4)).toISOString()).toBe(
      '2026-07-12T20:00:00.000Z',
    );
  });
});
