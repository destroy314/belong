import { describe, expect, it } from 'vitest';

import { createDatabase, DatabaseConflictError, MetadataStore } from '../src/db.js';

describe('MetadataStore', () => {
  it('stores users and only a hash of each session token', () => {
    const database = createDatabase(':memory:');
    const store = new MetadataStore(database);
    const user = store.upsertUserByOpenId('openid-owner', {
      nickname: '小满',
      avatarUrl: 'https://example.test/avatar.png',
    });
    const session = store.createSession(user.id, 60_000);
    const stored = database.prepare('SELECT token_hash FROM sessions').get()!;

    expect(store.getUserBySession(session.token)).toMatchObject({ id: user.id });
    expect(String(stored.token_hash)).not.toBe(session.token);
    expect(String(stored.token_hash)).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(session.token);
    database.close();
  });

  it('updates only the requested fields in a user profile', () => {
    const database = createDatabase(':memory:');
    const store = new MetadataStore(database);
    const user = store.upsertUserByOpenId('openid-profile', {
      nickname: '旧昵称',
      avatarUrl: 'https://example.test/old.png',
    });

    expect(store.updateUserProfile(user.id, { nickname: '新昵称' })).toMatchObject({
      nickname: '新昵称',
      avatarUrl: 'https://example.test/old.png',
    });
    database.close();
  });

  it('creates, joins and manages a shared family without inventory rows', () => {
    const database = createDatabase(':memory:');
    const store = new MetadataStore(database);
    const owner = store.upsertUserByOpenId('owner');
    const member = store.upsertUserByOpenId('member', { nickname: '阿禾' });
    const family = store.createFamily('我的家', owner.id);
    const joined = store.joinFamilyByInvite(family.inviteCode.toLowerCase(), member.id);

    expect(store.listFamiliesForUser(owner.id)[0]).toMatchObject({
      id: family.id,
      role: 'owner',
    });
    expect(joined).toMatchObject({ familyId: family.id, role: 'member' });
    expect(store.setMemberRole(family.id, member.id, 'admin').role).toBe('admin');
    expect(store.listMembers(family.id).map((entry) => entry.role)).toEqual([
      'owner',
      'admin',
    ]);
    expect(() => store.removeMember(family.id, owner.id)).toThrow(
      DatabaseConflictError,
    );
    expect(store.removeMember(family.id, member.id)).toBe(true);
    expect(store.getMembership(family.id, member.id)).toBeNull();
    const tables = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name));
    expect(tables).not.toContain('inventory_items');
    database.close();
  });

  it('deletes a family and cascades its dependent records', () => {
    const database = createDatabase(':memory:');
    const store = new MetadataStore(database);
    const owner = store.upsertUserByOpenId('owner');
    const member = store.upsertUserByOpenId('member');
    const family = store.createFamily('我的家', owner.id);
    store.joinFamilyByInvite(family.inviteCode, member.id);
    store.upsertLlmConfig({
      familyId: family.id,
      baseUrl: 'https://api.example.test/v1',
      model: 'test',
      apiKeyEncrypted: 'ciphertext',
    });
    store.addChatMessage({
      familyId: family.id,
      userId: owner.id,
      role: 'user',
      content: '测试消息',
    });

    expect(store.deleteFamily(family.id)).toBe(true);
    expect(store.getFamily(family.id)).toBeNull();
    expect(store.getMembership(family.id, owner.id)).toBeNull();
    expect(store.getMembership(family.id, member.id)).toBeNull();
    expect(store.getLlmConfig(family.id)).toBeNull();
    expect(store.listChatMessages(family.id)).toEqual([]);
    database.close();
  });

  it('preserves an encrypted BYOK value when only endpoint settings change', () => {
    const database = createDatabase(':memory:');
    const store = new MetadataStore(database);
    const owner = store.upsertUserByOpenId('owner');
    const family = store.createFamily('我的家', owner.id);
    store.upsertLlmConfig({
      familyId: family.id,
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      apiKeyEncrypted: 'ciphertext-never-return-directly',
    });
    const updated = store.upsertLlmConfig({
      familyId: family.id,
      baseUrl: 'https://llm.example.test/v1',
      model: 'other-model',
    });

    expect(updated).toMatchObject({
      baseUrl: 'https://llm.example.test/v1',
      model: 'other-model',
      apiKeyEncrypted: 'ciphertext-never-return-directly',
    });
    database.close();
  });

  it('returns recent chat in chronological order and clears older rows', () => {
    const database = createDatabase(':memory:');
    const store = new MetadataStore(database);
    const user = store.upsertUserByOpenId('owner');
    const family = store.createFamily('我的家', user.id);
    const old = store.addChatMessage({
      familyId: family.id,
      userId: user.id,
      role: 'user',
      content: '钥匙在哪？',
    });
    const reply = store.addChatMessage({
      familyId: family.id,
      userId: user.id,
      role: 'assistant',
      content: '在玄关。',
    });

    database
      .prepare('UPDATE chat_messages SET created_at = ? WHERE id = ?')
      .run(1, old.id);
    expect(store.listChatMessages(family.id, user.id)).toEqual([
      { ...old, createdAt: 1 },
      reply,
    ]);
    expect(store.deleteChatMessagesBefore(2)).toBe(1);
    expect(store.listChatMessages(family.id, user.id)).toEqual([reply]);
    database.close();
  });

  it('can reset only the current developer user’s chat in a family', () => {
    const database = createDatabase(':memory:');
    const store = new MetadataStore(database);
    const owner = store.upsertUserByOpenId('owner');
    const member = store.upsertUserByOpenId('member');
    const family = store.createFamily('我的家', owner.id);
    store.joinFamilyByInvite(family.inviteCode, member.id);
    store.addChatMessage({
      familyId: family.id,
      userId: owner.id,
      role: 'user',
      content: '我的会话',
    });
    const memberMessage = store.addChatMessage({
      familyId: family.id,
      userId: member.id,
      role: 'user',
      content: '成员会话',
    });

    expect(store.clearChatMessagesForUser(family.id, owner.id)).toBe(1);
    expect(store.listChatMessages(family.id, owner.id)).toEqual([]);
    expect(store.listChatMessages(family.id, member.id)).toEqual([memberMessage]);
    database.close();
  });
});
