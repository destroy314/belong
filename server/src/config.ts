import { mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AppConfig {
  port: number;
  host: string;
  dataDir: string;
  databasePath: string;
  inventoryDir: string;
  publicOrigin: string;
  wxAppId?: string;
  wxAppSecret?: string;
  allowDevWechatLogin: boolean;
  defaultLlm?: {
    baseUrl: string;
    model: string;
    apiKey: string;
  };
  encryptionKey: Buffer;
  chatHistoryLimit: number;
  agentConflictRetries: number;
  llmTimeoutMs: number;
  dayTimezoneOffsetMinutes: number;
  dayBoundaryHour: number;
}

function integer(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 之间的整数`);
  }
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function loadEncryptionKey(dataDir: string): Buffer {
  const configured = process.env.BYOK_ENCRYPTION_KEY?.trim();
  if (configured) {
    const hex = /^[0-9a-f]{64}$/i.test(configured)
      ? Buffer.from(configured, 'hex')
      : Buffer.from(configured, 'base64');
    if (hex.length !== 32) {
      throw new Error('BYOK_ENCRYPTION_KEY 必须是 32 字节的 Base64 或 64 位十六进制字符串');
    }
    return hex;
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('生产环境必须设置 BYOK_ENCRYPTION_KEY');
  }

  // 本地开发时生成并持久化主密钥，避免每次重启后无法解密。
  const keyPath = resolve(dataDir, '.byok-master-key');
  try {
    const stored = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64');
    if (stored.length !== 32) throw new Error('本地 BYOK 主密钥长度错误');
    return stored;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code && code !== 'ENOENT') throw error;
  }

  mkdirSync(dirname(keyPath), { recursive: true });
  const generated = randomBytes(32);
  writeFileSync(keyPath, generated.toString('base64'), { mode: 0o600, flag: 'wx' });
  chmodSync(keyPath, 0o600);
  return generated;
}

export function loadConfig(cwd = process.cwd()): AppConfig {
  const dataDir = resolve(cwd, process.env.DATA_DIR || 'data');
  mkdirSync(dataDir, { recursive: true });

  const defaultBaseUrl = process.env.LLM_BASE_URL?.trim();
  const defaultModel = process.env.LLM_MODEL?.trim();
  const defaultApiKey = process.env.LLM_API_KEY?.trim();
  const hasAnyDefaultLlm = Boolean(defaultBaseUrl || defaultModel || defaultApiKey);
  if (hasAnyDefaultLlm && !(defaultBaseUrl && defaultModel && defaultApiKey)) {
    throw new Error('LLM_BASE_URL、LLM_MODEL 和 LLM_API_KEY 必须同时设置');
  }

  const wxAppId = process.env.WX_APP_ID?.trim() || undefined;
  const wxAppSecret = process.env.WX_APP_SECRET?.trim() || undefined;
  if (process.env.NODE_ENV === 'production' && (!wxAppId || !wxAppSecret)) {
    throw new Error('生产环境必须设置 WX_APP_ID 和 WX_APP_SECRET');
  }

  return {
    port: integer('PORT', 3000, 1, 65535),
    host: process.env.HOST?.trim() || '0.0.0.0',
    dataDir,
    databasePath: resolve(dataDir, process.env.DATABASE_FILE || 'belong.sqlite'),
    inventoryDir: resolve(dataDir, process.env.INVENTORY_DIR || 'families'),
    publicOrigin: process.env.CORS_ORIGIN?.trim() || '*',
    ...(wxAppId ? { wxAppId } : {}),
    ...(wxAppSecret ? { wxAppSecret } : {}),
    allowDevWechatLogin:
      process.env.NODE_ENV !== 'production' && bool('DEV_WECHAT_LOGIN', true),
    ...(defaultBaseUrl && defaultModel && defaultApiKey
      ? {
          defaultLlm: {
            baseUrl: defaultBaseUrl,
            model: defaultModel,
            apiKey: defaultApiKey,
          },
        }
      : {}),
    encryptionKey: loadEncryptionKey(dataDir),
    chatHistoryLimit: integer('CHAT_HISTORY_LIMIT', 20, 1, 100),
    agentConflictRetries: integer('AGENT_CONFLICT_RETRIES', 2, 0, 5),
    llmTimeoutMs: integer('LLM_TIMEOUT_MS', 60_000, 1_000, 300_000),
    dayTimezoneOffsetMinutes: integer(
      'DAY_TIMEZONE_OFFSET_MINUTES',
      480,
      -12 * 60,
      14 * 60,
    ),
    dayBoundaryHour: integer('DAY_BOUNDARY_HOUR', 4, 0, 23),
  };
}

export function startOfLocalDayMs(
  nowMs: number,
  timezoneOffsetMinutes: number,
): number {
  const offsetMs = timezoneOffsetMinutes * 60_000;
  return Math.floor((nowMs + offsetMs) / 86_400_000) * 86_400_000 - offsetMs;
}

export function startOfSessionDayMs(
  nowMs: number,
  timezoneOffsetMinutes: number,
  boundaryHour: number,
): number {
  const boundaryMs = boundaryHour * 60 * 60 * 1_000;
  return startOfLocalDayMs(nowMs - boundaryMs, timezoneOffsetMinutes) + boundaryMs;
}
