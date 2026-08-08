import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { startOfSessionDayMs } from './config.js';
import { InventoryAgent, type AgentHistoryMessage, type InventoryGateway } from './agent.js';
import { decryptSecret, encryptSecret } from './security.js';
import { LlmError, validateLlmConfig, type LlmConfig } from './llm.js';
import { exchangeWechatCode, WechatAuthError } from './wechat.js';

type Role = 'owner' | 'admin' | 'member';

export interface UserRecord {
  id: string;
  nickname?: string | null;
  avatarUrl?: string | null;
}

export interface FamilyRecord {
  id: string;
  name: string;
  inviteCode?: string;
  role?: Role;
}

export interface MembershipRecord {
  familyId?: string;
  userId?: string;
  role: Role;
}

export interface StoredLlmConfig {
  familyId?: string;
  baseUrl: string;
  model: string;
  apiKeyEncrypted?: string | null;
}

export interface ChatRecord {
  role: string;
  content: string;
  createdAt: number | string;
}

export interface MetadataGateway {
  upsertUserByOpenId(
    openid: string,
    profile?: { nickname?: string; avatarUrl?: string },
  ): UserRecord;
  createSession(userId: string, ttl?: number): string | { token: string; expiresAt?: number };
  getUserBySession(token: string): UserRecord | undefined | null;
  updateUserProfile(
    userId: string,
    profile: { nickname?: string; avatarUrl?: string },
  ): UserRecord;
  createFamily(name: string, ownerUserId: string): FamilyRecord;
  listFamiliesForUser(userId: string): FamilyRecord[];
  getFamily(id: string): FamilyRecord | undefined | null;
  joinFamilyByInvite(inviteCode: string, userId: string): MembershipRecord;
  listMembers(familyId: string): unknown[];
  setMemberRole(
    familyId: string,
    userId: string,
    role: Exclude<Role, 'owner'>,
  ): unknown;
  removeMember(familyId: string, userId: string): boolean;
  deleteFamily(familyId: string): boolean;
  getMembership(familyId: string, userId: string): MembershipRecord | undefined | null;
  getLlmConfig(familyId: string): StoredLlmConfig | undefined | null;
  upsertLlmConfig(input: {
    familyId: string;
    baseUrl: string;
    model: string;
    apiKeyEncrypted?: string;
  }): StoredLlmConfig;
  listChatMessages(
    familyId: string,
    userId?: string,
    limit?: number,
    sinceMs?: number,
  ): ChatRecord[];
  addChatMessage(input: {
    familyId: string;
    userId?: string;
    role: 'user' | 'assistant';
    content: string;
  }): unknown;
  deleteChatMessagesBefore(cutoff: number): number | void;
  purgeExpiredSessions(now?: number): number | void;
  clearChatMessagesForUser(familyId: string, userId: string): number | void;
}

export interface FamilyInventoryGateway extends InventoryGateway {
  deleteFamily(familyId: string): Promise<void> | void;
}

export interface ApiDependencies {
  config: AppConfig;
  metadata: MetadataGateway;
  inventory: FamilyInventoryGateway;
  agent?: InventoryAgent;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'bad_request',
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

interface RequestContext {
  request: IncomingMessage;
  response: ServerResponse;
  url: URL;
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

function setCommonHeaders(response: ServerResponse, config: AppConfig): void {
  response.setHeader('access-control-allow-origin', config.publicOrigin);
  response.setHeader('access-control-allow-headers', 'authorization, content-type');
  response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('content-length', Buffer.byteLength(body));
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大', 'payload_too_large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, '请求体过大', 'payload_too_large');
    chunks.push(buffer);
  }
  if (total === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '请求体必须是 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求体必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

async function readBinary(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > maxBytes) throw new HttpError(413, '图片文件过大', 'payload_too_large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new HttpError(413, '图片文件过大', 'payload_too_large');
    chunks.push(buffer);
  }
  if (total === 0) throw new HttpError(400, '请选择图片');
  return Buffer.concat(chunks);
}

type AvatarFormat = 'jpg' | 'png' | 'webp';

function avatarFormat(contentType: string | undefined): AvatarFormat {
  const normalized = contentType?.split(';', 1)[0]?.trim().toLowerCase();
  if (normalized === 'image/jpeg') return 'jpg';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  throw new HttpError(415, '仅支持 JPG、PNG 或 WebP 图片', 'unsupported_media_type');
}

function hasValidAvatarSignature(data: Buffer, format: AvatarFormat): boolean {
  if (format === 'jpg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (format === 'png') return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
}

function requestOrigin(request: IncomingMessage): string {
  const host = request.headers.host;
  if (!host) throw new HttpError(500, '无法生成头像地址');
  const forwardedProtocol = request.headers['x-forwarded-proto'];
  const protocol =
    (typeof forwardedProtocol === 'string' && forwardedProtocol.split(',', 1)[0]) ||
    ('encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http');
  return `${protocol}://${host}`;
}

async function saveAvatar(
  config: AppConfig,
  userId: string,
  format: AvatarFormat,
  data: Buffer,
): Promise<string> {
  const directory = path.join(config.dataDir, 'avatars');
  await mkdir(directory, { recursive: true });
  const fileName = `${userId}-${randomUUID()}.${format}`;
  await writeFile(path.join(directory, fileName), data, { mode: 0o600 });
  return fileName;
}

async function sendAvatar(
  response: ServerResponse,
  config: AppConfig,
  fileName: string,
): Promise<void> {
  if (!/^[a-f0-9-]{1,100}\.(jpg|png|webp)$/i.test(fileName)) {
    throw new HttpError(404, '头像不存在', 'not_found');
  }
  let data: Buffer;
  try {
    data = await readFile(path.join(config.dataDir, 'avatars', fileName));
  } catch {
    throw new HttpError(404, '头像不存在', 'not_found');
  }
  const extension = fileName.split('.').at(-1);
  const contentType = extension === 'png' ? 'image/png' : extension === 'webp' ? 'image/webp' : 'image/jpeg';
  response.statusCode = 200;
  response.setHeader('content-type', contentType);
  response.setHeader('content-length', data.length);
  response.end(data);
}

function textField(
  body: Record<string, unknown>,
  key: string,
  options: { required?: boolean; max?: number } = {},
): string | undefined {
  const value = body[key];
  if (value == null && !options.required) return undefined;
  if (typeof value !== 'string' || !value.trim()) {
    throw new HttpError(400, `${key} 不能为空`);
  }
  const normalized = value.trim();
  if (normalized.length > (options.max ?? 200)) {
    throw new HttpError(400, `${key} 过长`);
  }
  return normalized;
}

function bearerToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;
  const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
  if (!match?.[1]) throw new HttpError(401, '请先登录', 'unauthorized');
  return match[1];
}

function requireUser(request: IncomingMessage, metadata: MetadataGateway): UserRecord {
  const user = metadata.getUserBySession(bearerToken(request));
  if (!user) throw new HttpError(401, '登录已失效', 'unauthorized');
  return user;
}

function requireMembership(
  familyId: string,
  userId: string,
  metadata: MetadataGateway,
): MembershipRecord {
  const family = metadata.getFamily(familyId);
  if (!family) throw new HttpError(404, '家庭不存在', 'not_found');
  const membership = metadata.getMembership(familyId, userId);
  if (!membership) throw new HttpError(403, '你不是该家庭成员', 'forbidden');
  return membership;
}

function requireOwner(
  familyId: string,
  userId: string,
  metadata: MetadataGateway,
): MembershipRecord {
  const membership = requireMembership(familyId, userId, metadata);
  if (membership.role !== 'owner' && membership.role !== 'admin') {
    throw new HttpError(403, '只有家庭管理者可以执行此操作', 'forbidden');
  }
  return membership;
}

function requireCreator(
  familyId: string,
  userId: string,
  metadata: MetadataGateway,
): MembershipRecord {
  const membership = requireMembership(familyId, userId, metadata);
  if (membership.role !== 'owner') {
    throw new HttpError(403, '只有家庭创建者可以执行此操作', 'forbidden');
  }
  return membership;
}

function chatTimestampMs(value: number | string): number {
  if (typeof value === 'number') return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function publicUser(user: UserRecord): Pick<UserRecord, 'id' | 'nickname' | 'avatarUrl'> {
  return {
    id: user.id,
    ...(typeof user.nickname === 'string' ? { nickname: user.nickname } : {}),
    ...(typeof user.avatarUrl === 'string' ? { avatarUrl: user.avatarUrl } : {}),
  };
}

function publicMembers(members: unknown[]): unknown[] {
  return members.map((member) => {
    if (!member || typeof member !== 'object') return member;
    const record = member as Record<string, unknown>;
    return {
      ...record,
      ...(typeof record.userId === 'string' ? { id: record.userId } : {}),
    };
  });
}

function familyLlmConfig(
  familyId: string,
  metadata: MetadataGateway,
  config: AppConfig,
): LlmConfig {
  const stored = metadata.getLlmConfig(familyId);
  if (!stored) {
    if (!config.defaultLlm) {
      throw new HttpError(409, '该家庭尚未配置 LLM', 'llm_not_configured');
    }
    return config.defaultLlm;
  }
  if (!stored.apiKeyEncrypted) {
    throw new HttpError(409, '该家庭的 LLM API Key 尚未配置', 'llm_not_configured');
  }
  let apiKey: string;
  try {
    apiKey = decryptSecret(
      stored.apiKeyEncrypted,
      config.encryptionKey,
      `family-llm:${familyId}`,
    );
  } catch {
    throw new HttpError(500, 'LLM API Key 无法解密', 'llm_config_error');
  }
  return { baseUrl: stored.baseUrl, model: stored.model, apiKey };
}

function routeFamilyId(pathname: string, suffix: string): string | undefined {
  const suffixPath = suffix ? `/${suffix}` : '';
  const match = pathname.match(new RegExp(`^/api/families/([^/]+)${suffixPath}$`));
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    throw new HttpError(400, '家庭 ID 无效');
  }
}

export function createApiServer(dependencies: ApiDependencies): Server {
  const { config, metadata, inventory } = dependencies;
  const agent =
    dependencies.agent ??
    new InventoryAgent({
      inventory,
      timeoutMs: config.llmTimeoutMs,
      conflictRetries: config.agentConflictRetries,
    });

  return createServer(async (request, response) => {
    setCommonHeaders(response, config);
    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }
    const context: RequestContext = {
      request,
      response,
      url: new URL(request.url || '/', 'http://localhost'),
    };
    try {
      await handleRequest(context, { config, metadata, inventory, agent });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError) {
        json(response, error.status, { error: { code: error.code, message: error.message } });
        return;
      }
      if (error instanceof WechatAuthError) {
        json(response, 401, { error: { code: 'wechat_login_failed', message: error.message } });
        return;
      }
      if (error instanceof LlmError) {
        json(response, 502, { error: { code: 'llm_error', message: error.message } });
        return;
      }
      // 不记录请求体、Authorization 或异常 message，防止 API Key 进入日志。
      console.error(
        `[api] ${request.method || 'UNKNOWN'} ${context.url.pathname}: ${error instanceof Error ? error.name : 'UnknownError'}`,
      );
      json(response, 500, { error: { code: 'internal_error', message: '服务器内部错误' } });
    }
  });
}

async function handleRequest(
  context: RequestContext,
  dependencies: ApiDependencies & { agent: InventoryAgent },
): Promise<void> {
  const { request, response, url } = context;
  const { config, metadata, inventory, agent } = dependencies;
  const method = request.method || 'GET';
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (method === 'GET' && pathname === '/health') {
    json(response, 200, { ok: true });
    return;
  }

  const avatarMatch = pathname.match(/^\/uploads\/avatars\/([^/]+)$/);
  if (method === 'GET' && avatarMatch?.[1]) {
    await sendAvatar(response, config, avatarMatch[1]);
    return;
  }

  if (method === 'POST' && pathname === '/api/auth/wechat') {
    const body = await readJson(request);
    const code = textField(body, 'code', { required: true, max: 512 })!;
    const nickname = textField(body, 'nickname', { max: 50 });
    const avatarUrl = textField(body, 'avatarUrl', { max: 2_000 });
    const devOpenid = textField(body, 'devOpenid', { max: 128 });
    const identity = await exchangeWechatCode(code, {
      ...(config.wxAppId ? { appId: config.wxAppId } : {}),
      ...(config.wxAppSecret ? { appSecret: config.wxAppSecret } : {}),
      allowDevLogin: config.allowDevWechatLogin,
      ...(config.allowDevWechatLogin && devOpenid ? { devOpenid } : {}),
    });
    const user = metadata.upsertUserByOpenId(identity.openid, {
      ...(nickname ? { nickname } : {}),
      ...(avatarUrl ? { avatarUrl } : {}),
    });
    const created = metadata.createSession(user.id);
    const token = typeof created === 'string' ? created : created.token;
    json(response, 200, { token, user: publicUser(user) });
    return;
  }

  const user = requireUser(request, metadata);

  if (method === 'PUT' && pathname === '/api/users/me') {
    const body = await readJson(request);
    const nickname = textField(body, 'nickname', { required: true, max: 50 })!;
    if (Array.from(nickname).length > 10) {
      throw new HttpError(400, '昵称最多 10 个字符');
    }
    const avatarUrl = textField(body, 'avatarUrl', { max: 2_000 });
    if (avatarUrl && !/^https?:\/\//i.test(avatarUrl)) {
      throw new HttpError(400, 'avatarUrl 必须是 http 或 https 地址');
    }
    const updated = metadata.updateUserProfile(user.id, {
      nickname,
      ...(avatarUrl ? { avatarUrl } : {}),
    });
    json(response, 200, { user: publicUser(updated) });
    return;
  }

  if (method === 'POST' && pathname === '/api/users/me/avatar') {
    const format = avatarFormat(request.headers['content-type']);
    const data = await readBinary(request, MAX_AVATAR_BYTES);
    if (!hasValidAvatarSignature(data, format)) {
      throw new HttpError(400, '图片内容无效');
    }
    const fileName = await saveAvatar(config, user.id, format, data);
    const updated = metadata.updateUserProfile(user.id, {
      avatarUrl: `${requestOrigin(request)}/uploads/avatars/${fileName}`,
    });
    json(response, 200, { user: publicUser(updated) });
    return;
  }

  const devChatResetFamilyId = routeFamilyId(pathname, 'chat/reset');
  if (devChatResetFamilyId && method === 'POST') {
    if (process.env.NODE_ENV === 'production') {
      throw new HttpError(404, '接口不存在', 'not_found');
    }
    requireMembership(devChatResetFamilyId, user.id, metadata);
    const removed = metadata.clearChatMessagesForUser(devChatResetFamilyId, user.id);
    json(response, 200, { removed: removed ?? 0 });
    return;
  }

  if (method === 'GET' && pathname === '/api/families') {
    json(response, 200, { families: metadata.listFamiliesForUser(user.id) });
    return;
  }

  if (method === 'POST' && pathname === '/api/families') {
    const body = await readJson(request);
    const name = textField(body, 'name', { required: true, max: 80 })!;
    const family = metadata.createFamily(name, user.id);
    await inventory.load(family.id);
    json(response, 201, { family: { ...family, role: 'owner' } });
    return;
  }

  if (method === 'POST' && pathname === '/api/families/join') {
    const body = await readJson(request);
    const inviteCode = textField(body, 'inviteCode', { required: true, max: 32 })!;
    let membership: MembershipRecord;
    try {
      membership = metadata.joinFamilyByInvite(inviteCode, user.id);
    } catch {
      throw new HttpError(404, '邀请码无效', 'invite_not_found');
    }
    const family = metadata.getFamily(membership.familyId!);
    if (!family) throw new HttpError(404, '家庭不存在', 'not_found');
    json(response, 200, { family: { ...family, role: membership.role } });
    return;
  }

  const inventoryFamilyId = routeFamilyId(pathname, 'inventory');
  if (inventoryFamilyId && method === 'GET') {
    requireMembership(inventoryFamilyId, user.id, metadata);
    const snapshot = await inventory.load(inventoryFamilyId);
    json(response, 200, { content: snapshot.content, version: snapshot.version });
    return;
  }

  const membersFamilyId = routeFamilyId(pathname, 'members');
  if (membersFamilyId && method === 'GET') {
    requireMembership(membersFamilyId, user.id, metadata);
    json(response, 200, {
      members: publicMembers(metadata.listMembers(membersFamilyId)),
    });
    return;
  }

  const leaveFamilyId = routeFamilyId(pathname, 'members/me');
  if (leaveFamilyId && method === 'DELETE') {
    const membership = requireMembership(leaveFamilyId, user.id, metadata);
    if (membership.role === 'owner') {
      throw new HttpError(409, '家庭创建者不能退出家庭，请删除家庭', 'owner_cannot_leave');
    }
    metadata.removeMember(leaveFamilyId, user.id);
    json(response, 200, { removed: true });
    return;
  }

  const memberRoleMatch = pathname.match(/^\/api\/families\/([^/]+)\/members\/([^/]+)$/);
  if (memberRoleMatch && method === 'PATCH') {
    const familyId = decodeURIComponent(memberRoleMatch[1]!);
    const memberUserId = decodeURIComponent(memberRoleMatch[2]!);
    requireOwner(familyId, user.id, metadata);
    const body = await readJson(request);
    if (body.role !== 'admin' && body.role !== 'member') {
      throw new HttpError(400, 'role 必须是 admin 或 member');
    }
    metadata.setMemberRole(familyId, memberUserId, body.role);
    json(response, 200, { members: publicMembers(metadata.listMembers(familyId)) });
    return;
  }

  if (memberRoleMatch && method === 'DELETE') {
    const familyId = decodeURIComponent(memberRoleMatch[1]!);
    const memberUserId = decodeURIComponent(memberRoleMatch[2]!);
    requireCreator(familyId, user.id, metadata);
    const member = metadata.getMembership(familyId, memberUserId);
    if (!member) throw new HttpError(404, '家庭成员不存在', 'not_found');
    if (member.role === 'owner') {
      throw new HttpError(409, '不能移除家庭创建者', 'owner_cannot_be_removed');
    }
    metadata.removeMember(familyId, memberUserId);
    json(response, 200, { removed: true });
    return;
  }

  const familyId = routeFamilyId(pathname, '');
  if (familyId && method === 'DELETE') {
    requireCreator(familyId, user.id, metadata);
    await inventory.deleteFamily(familyId);
    if (!metadata.deleteFamily(familyId)) {
      throw new HttpError(404, '家庭不存在', 'not_found');
    }
    json(response, 200, { deleted: true });
    return;
  }

  const llmFamilyId = routeFamilyId(pathname, 'llm-config');
  if (llmFamilyId && method === 'GET') {
    requireMembership(llmFamilyId, user.id, metadata);
    const stored = metadata.getLlmConfig(llmFamilyId);
    if (stored) {
      json(response, 200, {
        baseUrl: stored.baseUrl,
        model: stored.model,
        hasApiKey: Boolean(stored.apiKeyEncrypted),
        configured: true,
        usingDefault: false,
      });
    } else if (config.defaultLlm) {
      json(response, 200, {
        baseUrl: config.defaultLlm.baseUrl,
        model: config.defaultLlm.model,
        hasApiKey: false,
        configured: false,
        usingDefault: true,
      });
    } else {
      json(response, 200, {
        baseUrl: '',
        model: '',
        hasApiKey: false,
        configured: false,
        usingDefault: false,
      });
    }
    return;
  }

  if (llmFamilyId && method === 'PUT') {
    requireOwner(llmFamilyId, user.id, metadata);
    const body = await readJson(request);
    let normalized: ReturnType<typeof validateLlmConfig>;
    try {
      normalized = validateLlmConfig({
        baseUrl: body.baseUrl,
        model: body.model,
        apiKey: body.apiKey,
      });
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'LLM 配置无效');
    }
    const existing = metadata.getLlmConfig(llmFamilyId);
    const apiKeyEncrypted = normalized.apiKey
      ? encryptSecret(
          normalized.apiKey,
          config.encryptionKey,
          `family-llm:${llmFamilyId}`,
        )
      : existing?.apiKeyEncrypted || undefined;
    if (!apiKeyEncrypted) {
      throw new HttpError(400, '首次配置必须提供 apiKey');
    }
    metadata.upsertLlmConfig({
      familyId: llmFamilyId,
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      apiKeyEncrypted,
    });
    json(response, 200, {
      baseUrl: normalized.baseUrl,
      model: normalized.model,
      hasApiKey: true,
      configured: true,
      usingDefault: false,
    });
    return;
  }

  const chatFamilyId = routeFamilyId(pathname, 'chat');
  if (chatFamilyId && method === 'POST') {
    requireMembership(chatFamilyId, user.id, metadata);
    const body = await readJson(request);
    const message = textField(body, 'message', { required: true, max: 4_000 })!;
    const now = Date.now();
    const cutoff = startOfSessionDayMs(
      now,
      config.dayTimezoneOffsetMinutes,
      config.dayBoundaryHour,
    );
    const history: AgentHistoryMessage[] = metadata
      .listChatMessages(chatFamilyId, user.id, config.chatHistoryLimit, cutoff)
      .filter((item) => chatTimestampMs(item.createdAt) >= cutoff)
      .filter(
        (item): item is ChatRecord & { role: 'user' | 'assistant' } =>
          (item.role === 'user' || item.role === 'assistant') &&
          typeof item.content === 'string',
      )
      .map((item) => ({ role: item.role, content: item.content }));
    const result = await agent.run({
      familyId: chatFamilyId,
      message,
      history,
      llm: familyLlmConfig(chatFamilyId, metadata, config),
      ...(user.nickname !== undefined ? { userNickname: user.nickname } : {}),
    });
    metadata.addChatMessage({
      familyId: chatFamilyId,
      userId: user.id,
      role: 'user',
      content: message,
    });
    metadata.addChatMessage({
      familyId: chatFamilyId,
      userId: user.id,
      role: 'assistant',
      content: result.reply,
    });
    json(response, 200, result);
    return;
  }

  throw new HttpError(404, '接口不存在', 'not_found');
}

export function startDailyChatCleanup(
  metadata: MetadataGateway,
  timezoneOffsetMinutes: number,
  boundaryHour: number,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const schedule = (): void => {
    if (stopped) return;
    const now = Date.now();
    const cutoff = startOfSessionDayMs(now, timezoneOffsetMinutes, boundaryHour);
    metadata.deleteChatMessagesBefore(cutoff);
    metadata.purgeExpiredSessions();
    const nextBoundary = cutoff + 86_400_000;
    timer = setTimeout(() => {
      schedule();
    }, Math.max(1_000, nextBoundary - now + 100));
    timer.unref();
  };
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
