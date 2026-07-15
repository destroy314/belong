import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite';

export type MemberRole = 'owner' | 'admin' | 'member';
export type ChatRole = 'user' | 'assistant' | 'system' | 'tool';

export interface User {
  id: string;
  openid: string;
  nickname: string | null;
  avatarUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UserProfile {
  nickname?: string | null;
  avatarUrl?: string | null;
}

export interface Session {
  token: string;
  expiresAt: number;
}

export interface Family {
  id: string;
  name: string;
  inviteCode: string;
  ownerUserId: string;
  createdAt: number;
  updatedAt: number;
}

export interface FamilyWithRole extends Family {
  role: MemberRole;
}

export interface Membership {
  familyId: string;
  userId: string;
  role: MemberRole;
  joinedAt: number;
}

export interface FamilyMember extends Membership {
  nickname: string | null;
  avatarUrl: string | null;
}

export interface LlmConfig {
  familyId: string;
  baseUrl: string;
  model: string;
  apiKeyEncrypted: string | null;
  updatedAt: number;
}

export interface LlmConfigInput {
  familyId: string;
  baseUrl: string;
  model: string;
  apiKeyEncrypted?: string | null;
}

export interface ChatMessage {
  id: string;
  familyId: string;
  userId: string | null;
  role: ChatRole;
  content: string;
  createdAt: number;
}

export interface AddChatMessageInput {
  familyId: string;
  userId?: string | null;
  role: ChatRole;
  content: string;
}

export class DatabaseNotFoundError extends Error {
  readonly code = 'NOT_FOUND';

  constructor(message: string) {
    super(message);
    this.name = 'DatabaseNotFoundError';
  }
}

export class DatabaseConflictError extends Error {
  readonly code = 'CONFLICT';

  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConflictError';
  }
}

export function createDatabase(databasePath: string): DatabaseSync {
  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  }
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (databasePath !== ':memory:') database.exec('PRAGMA journal_mode = WAL;');
  initializeSchema(database);
  return database;
}

export function initializeSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      openid TEXT NOT NULL UNIQUE,
      nickname TEXT,
      avatar_url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS families (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      owner_user_id TEXT NOT NULL REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS family_members (
      family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (family_id, user_id)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS family_members_user_id_idx
      ON family_members(user_id);

    CREATE TABLE IF NOT EXISTS llm_configs (
      family_id TEXT PRIMARY KEY REFERENCES families(id) ON DELETE CASCADE,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key_encrypted TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS chat_messages_family_created_idx
      ON chat_messages(family_id, created_at);
    CREATE INDEX IF NOT EXISTS chat_messages_user_created_idx
      ON chat_messages(user_id, created_at);

    PRAGMA user_version = 1;
  `);
}

export class MetadataStore {
  constructor(readonly database: DatabaseSync) {}

  upsertUserByOpenId(openid: string, profile: UserProfile = {}): User {
    const normalizedOpenid = requireText(openid, 'openid');
    const existing = this.getUserByOpenId(normalizedOpenid);
    const now = Date.now();
    if (existing) {
      this.database
        .prepare(`
          UPDATE users
          SET nickname = CASE WHEN ? IS NULL THEN nickname ELSE ? END,
              avatar_url = CASE WHEN ? IS NULL THEN avatar_url ELSE ? END,
              updated_at = ?
          WHERE id = ?
        `)
        .run(
          profile.nickname === undefined ? null : 1,
          profile.nickname ?? null,
          profile.avatarUrl === undefined ? null : 1,
          profile.avatarUrl ?? null,
          now,
          existing.id,
        );
      return this.getUserById(existing.id)!;
    }

    const user: User = {
      id: randomUUID(),
      openid: normalizedOpenid,
      nickname: profile.nickname ?? null,
      avatarUrl: profile.avatarUrl ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.database
      .prepare(`
        INSERT INTO users (id, openid, nickname, avatar_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        user.id,
        user.openid,
        user.nickname,
        user.avatarUrl,
        user.createdAt,
        user.updatedAt,
      );
    return user;
  }

  getUserById(id: string): User | null {
    const row = this.database
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(id);
    return row ? mapUser(row) : null;
  }

  getUserByOpenId(openid: string): User | null {
    const row = this.database
      .prepare('SELECT * FROM users WHERE openid = ?')
      .get(openid);
    return row ? mapUser(row) : null;
  }

  updateUserProfile(userId: string, profile: UserProfile): User {
    const existing = this.getUserById(userId);
    if (!existing) throw new DatabaseNotFoundError('User not found');
    const now = Date.now();
    this.database
      .prepare(`
        UPDATE users
        SET nickname = CASE WHEN ? IS NULL THEN nickname ELSE ? END,
            avatar_url = CASE WHEN ? IS NULL THEN avatar_url ELSE ? END,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        profile.nickname === undefined ? null : 1,
        profile.nickname ?? null,
        profile.avatarUrl === undefined ? null : 1,
        profile.avatarUrl ?? null,
        now,
        userId,
      );
    return this.getUserById(userId)!;
  }

  createSession(userId: string, ttlMs = 30 * 24 * 60 * 60 * 1000): Session {
    if (!this.getUserById(userId)) throw new DatabaseNotFoundError('User not found');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('Session ttlMs must be a positive integer');
    }
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = now + ttlMs;
    this.database
      .prepare(`
        INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(hashToken(token), userId, expiresAt, now);
    return { token, expiresAt };
  }

  getUserBySession(token: string): User | null {
    if (!token) return null;
    const row = this.database
      .prepare(`
        SELECT users.*
        FROM sessions
        JOIN users ON users.id = sessions.user_id
        WHERE sessions.token_hash = ? AND sessions.expires_at > ?
      `)
      .get(hashToken(token), Date.now());
    return row ? mapUser(row) : null;
  }

  deleteSession(token: string): boolean {
    if (!token) return false;
    const result = this.database
      .prepare('DELETE FROM sessions WHERE token_hash = ?')
      .run(hashToken(token));
    return Number(result.changes) > 0;
  }

  purgeExpiredSessions(now = Date.now()): number {
    const result = this.database
      .prepare('DELETE FROM sessions WHERE expires_at <= ?')
      .run(now);
    return Number(result.changes);
  }

  createFamily(name: string, ownerUserId: string): Family {
    const normalizedName = requireText(name, 'family name');
    if (!this.getUserById(ownerUserId)) {
      throw new DatabaseNotFoundError('Owner user not found');
    }

    const now = Date.now();
    const family: Family = {
      id: randomUUID(),
      name: normalizedName,
      inviteCode: this.createUniqueInviteCode(),
      ownerUserId,
      createdAt: now,
      updatedAt: now,
    };
    inTransaction(this.database, () => {
      this.database
        .prepare(`
          INSERT INTO families
            (id, name, invite_code, owner_user_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(
          family.id,
          family.name,
          family.inviteCode,
          family.ownerUserId,
          family.createdAt,
          family.updatedAt,
        );
      this.database
        .prepare(`
          INSERT INTO family_members (family_id, user_id, role, joined_at)
          VALUES (?, ?, 'owner', ?)
        `)
        .run(family.id, ownerUserId, now);
    });
    return family;
  }

  getFamily(id: string): Family | null {
    const row = this.database
      .prepare('SELECT * FROM families WHERE id = ?')
      .get(id);
    return row ? mapFamily(row) : null;
  }

  getFamilyByInviteCode(inviteCode: string): Family | null {
    const row = this.database
      .prepare('SELECT * FROM families WHERE invite_code = ?')
      .get(normalizeInviteCode(inviteCode));
    return row ? mapFamily(row) : null;
  }

  listFamiliesForUser(userId: string): FamilyWithRole[] {
    return this.database
      .prepare(`
        SELECT families.*, family_members.role
        FROM family_members
        JOIN families ON families.id = family_members.family_id
        WHERE family_members.user_id = ?
        ORDER BY family_members.joined_at ASC
      `)
      .all(userId)
      .map(mapFamilyWithRole);
  }

  joinFamilyByInvite(inviteCode: string, userId: string): Membership {
    if (!this.getUserById(userId)) throw new DatabaseNotFoundError('User not found');
    const family = this.getFamilyByInviteCode(inviteCode);
    if (!family) throw new DatabaseNotFoundError('Invite code not found');
    const existing = this.getMembership(family.id, userId);
    if (existing) return existing;

    const membership: Membership = {
      familyId: family.id,
      userId,
      role: 'member',
      joinedAt: Date.now(),
    };
    this.database
      .prepare(`
        INSERT INTO family_members (family_id, user_id, role, joined_at)
        VALUES (?, ?, ?, ?)
      `)
      .run(
        membership.familyId,
        membership.userId,
        membership.role,
        membership.joinedAt,
      );
    return membership;
  }

  getMembership(familyId: string, userId: string): Membership | null {
    const row = this.database
      .prepare(`
        SELECT family_id, user_id, role, joined_at
        FROM family_members WHERE family_id = ? AND user_id = ?
      `)
      .get(familyId, userId);
    return row ? mapMembership(row) : null;
  }

  listMembers(familyId: string): FamilyMember[] {
    return this.database
      .prepare(`
        SELECT family_members.*, users.nickname, users.avatar_url
        FROM family_members
        JOIN users ON users.id = family_members.user_id
        WHERE family_members.family_id = ?
        ORDER BY
          CASE family_members.role
            WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2
          END,
          family_members.joined_at ASC
      `)
      .all(familyId)
      .map(mapFamilyMember);
  }

  setMemberRole(
    familyId: string,
    userId: string,
    role: Exclude<MemberRole, 'owner'>,
  ): Membership {
    if (role !== 'admin' && role !== 'member') throw new Error('Invalid member role');
    const family = this.getFamily(familyId);
    if (!family) throw new DatabaseNotFoundError('Family not found');
    if (family.ownerUserId === userId) {
      throw new DatabaseConflictError('The family owner role cannot be changed');
    }
    const result = this.database
      .prepare(`
        UPDATE family_members SET role = ? WHERE family_id = ? AND user_id = ?
      `)
      .run(role, familyId, userId);
    if (Number(result.changes) === 0) {
      throw new DatabaseNotFoundError('Family member not found');
    }
    return this.getMembership(familyId, userId)!;
  }

  removeMember(familyId: string, userId: string): boolean {
    const family = this.getFamily(familyId);
    if (!family) throw new DatabaseNotFoundError('Family not found');
    if (family.ownerUserId === userId) {
      throw new DatabaseConflictError('The family owner cannot be removed');
    }
    const result = this.database
      .prepare('DELETE FROM family_members WHERE family_id = ? AND user_id = ?')
      .run(familyId, userId);
    return Number(result.changes) > 0;
  }

  deleteFamily(familyId: string): boolean {
    const result = this.database
      .prepare('DELETE FROM families WHERE id = ?')
      .run(familyId);
    return Number(result.changes) > 0;
  }

  regenerateInviteCode(familyId: string): Family {
    if (!this.getFamily(familyId)) throw new DatabaseNotFoundError('Family not found');
    const inviteCode = this.createUniqueInviteCode();
    this.database
      .prepare('UPDATE families SET invite_code = ?, updated_at = ? WHERE id = ?')
      .run(inviteCode, Date.now(), familyId);
    return this.getFamily(familyId)!;
  }

  getLlmConfig(familyId: string): LlmConfig | null {
    const row = this.database
      .prepare('SELECT * FROM llm_configs WHERE family_id = ?')
      .get(familyId);
    return row ? mapLlmConfig(row) : null;
  }

  upsertLlmConfig(input: LlmConfigInput): LlmConfig {
    const baseUrl = requireText(input.baseUrl, 'LLM base URL');
    const model = requireText(input.model, 'LLM model');
    if (!this.getFamily(input.familyId)) {
      throw new DatabaseNotFoundError('Family not found');
    }
    const existing = this.getLlmConfig(input.familyId);
    const apiKeyEncrypted =
      input.apiKeyEncrypted === undefined
        ? existing?.apiKeyEncrypted ?? null
        : input.apiKeyEncrypted;
    const updatedAt = Date.now();
    this.database
      .prepare(`
        INSERT INTO llm_configs
          (family_id, base_url, model, api_key_encrypted, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(family_id) DO UPDATE SET
          base_url = excluded.base_url,
          model = excluded.model,
          api_key_encrypted = excluded.api_key_encrypted,
          updated_at = excluded.updated_at
      `)
      .run(input.familyId, baseUrl, model, apiKeyEncrypted, updatedAt);
    return this.getLlmConfig(input.familyId)!;
  }

  addChatMessage(input: AddChatMessageInput): ChatMessage {
    const content = requireText(input.content, 'chat content');
    assertChatRole(input.role);
    if (!this.getFamily(input.familyId)) {
      throw new DatabaseNotFoundError('Family not found');
    }
    const message: ChatMessage = {
      id: randomUUID(),
      familyId: input.familyId,
      userId: input.userId ?? null,
      role: input.role,
      content,
      createdAt: Date.now(),
    };
    this.database
      .prepare(`
        INSERT INTO chat_messages
          (id, family_id, user_id, role, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        message.id,
        message.familyId,
        message.userId,
        message.role,
        message.content,
        message.createdAt,
      );
    return message;
  }

  listChatMessages(
    familyId: string,
    userId?: string,
    limit = 50,
    sinceMs?: number,
  ): ChatMessage[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const clauses = ['family_id = ?'];
    const parameters: Array<string | number> = [familyId];
    if (userId !== undefined) {
      clauses.push('user_id = ?');
      parameters.push(userId);
    }
    if (sinceMs !== undefined) {
      clauses.push('created_at >= ?');
      parameters.push(sinceMs);
    }
    parameters.push(safeLimit);
    return this.database
      .prepare(`
        SELECT * FROM (
          SELECT chat_messages.*, rowid AS sequence FROM chat_messages
          WHERE ${clauses.join(' AND ')}
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?
        ) recent
        ORDER BY created_at ASC, sequence ASC
      `)
      .all(...parameters)
      .map(mapChatMessage);
  }

  deleteChatMessagesBefore(cutoff: number | Date): number {
    const cutoffMs = cutoff instanceof Date ? cutoff.getTime() : cutoff;
    const result = this.database
      .prepare('DELETE FROM chat_messages WHERE created_at < ?')
      .run(cutoffMs);
    return Number(result.changes);
  }

  clearChatMessagesForUser(familyId: string, userId: string): number {
    const result = this.database
      .prepare('DELETE FROM chat_messages WHERE family_id = ? AND user_id = ?')
      .run(familyId, userId);
    return Number(result.changes);
  }

  clearChatMessagesForFamily(familyId: string): number {
    const result = this.database
      .prepare('DELETE FROM chat_messages WHERE family_id = ?')
      .run(familyId);
    return Number(result.changes);
  }

  private createUniqueInviteCode(): string {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = createInviteCode();
      const existing = this.database
        .prepare('SELECT 1 AS found FROM families WHERE invite_code = ?')
        .get(code);
      if (!existing) return code;
    }
    throw new DatabaseConflictError('Unable to allocate an invite code');
  }
}

function inTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

function createInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let result = '';
  for (const byte of bytes) result += alphabet[byte % alphabet.length];
  return result;
}

function normalizeInviteCode(inviteCode: string): string {
  return requireText(inviteCode, 'invite code').replace(/\s+/g, '').toUpperCase();
}

function requireText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function assertChatRole(role: string): asserts role is ChatRole {
  if (!['user', 'assistant', 'system', 'tool'].includes(role)) {
    throw new Error('Invalid chat role');
  }
}

type Row = Record<string, SQLOutputValue>;

function mapUser(row: Row): User {
  return {
    id: String(row.id),
    openid: String(row.openid),
    nickname: nullableString(row.nickname),
    avatarUrl: nullableString(row.avatar_url),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapFamily(row: Row): Family {
  return {
    id: String(row.id),
    name: String(row.name),
    inviteCode: String(row.invite_code),
    ownerUserId: String(row.owner_user_id),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapFamilyWithRole(row: Row): FamilyWithRole {
  return { ...mapFamily(row), role: String(row.role) as MemberRole };
}

function mapMembership(row: Row): Membership {
  return {
    familyId: String(row.family_id),
    userId: String(row.user_id),
    role: String(row.role) as MemberRole,
    joinedAt: Number(row.joined_at),
  };
}

function mapFamilyMember(row: Row): FamilyMember {
  return {
    ...mapMembership(row),
    nickname: nullableString(row.nickname),
    avatarUrl: nullableString(row.avatar_url),
  };
}

function mapLlmConfig(row: Row): LlmConfig {
  return {
    familyId: String(row.family_id),
    baseUrl: String(row.base_url),
    model: String(row.model),
    apiKeyEncrypted: nullableString(row.api_key_encrypted),
    updatedAt: Number(row.updated_at),
  };
}

function mapChatMessage(row: Row): ChatMessage {
  return {
    id: String(row.id),
    familyId: String(row.family_id),
    userId: nullableString(row.user_id),
    role: String(row.role) as ChatRole,
    content: String(row.content),
    createdAt: Number(row.created_at),
  };
}

function nullableString(value: SQLOutputValue | undefined): string | null {
  return value === null || value === undefined ? null : String(value);
}
