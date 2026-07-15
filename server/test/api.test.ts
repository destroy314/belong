import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createApiServer } from '../src/api.js';
import type { AppConfig } from '../src/config.js';
import { createDatabase, MetadataStore } from '../src/db.js';
import { InventoryStore } from '../src/inventory.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('家庭成员与删除接口', () => {
  it('仅允许创建者移除成员和删除家庭，成员可自行退出', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belong-api-'));
    temporaryDirectories.push(root);
    const database = createDatabase(':memory:');
    const metadata = new MetadataStore(database);
    const inventory = new InventoryStore(path.join(root, 'families'));
    const owner = metadata.upsertUserByOpenId('owner');
    const admin = metadata.upsertUserByOpenId('admin');
    const member = metadata.upsertUserByOpenId('member');
    const family = metadata.createFamily('我的家', owner.id);
    metadata.joinFamilyByInvite(family.inviteCode, admin.id);
    metadata.joinFamilyByInvite(family.inviteCode, member.id);
    metadata.setMemberRole(family.id, admin.id, 'admin');
    await inventory.load(family.id);

    const server = createApiServer({ config: testConfig(root), metadata, inventory });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api`;
    const ownerToken = metadata.createSession(owner.id).token;
    const adminToken = metadata.createSession(admin.id).token;
    const memberToken = metadata.createSession(member.id).token;
    const request = (url: string, token: string) =>
      fetch(`${baseUrl}${url}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
    const updateProfile = (token: string) =>
      fetch(`${baseUrl}/users/me`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          nickname: '新创建者',
          avatarUrl: 'https://example.test/avatar.png',
        }),
      });
    const updateLongNickname = (token: string) =>
      fetch(`${baseUrl}/users/me`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ nickname: '一二三四五六七八九十十一' }),
      });
    const uploadAvatar = (token: string) =>
      fetch(`${baseUrl}/users/me/avatar`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'image/png',
        },
        body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      });

    try {
      expect((await updateLongNickname(ownerToken)).status).toBe(400);
      expect((await updateProfile(ownerToken)).status).toBe(200);
      expect(metadata.getUserById(owner.id)).toMatchObject({
        nickname: '新创建者',
        avatarUrl: 'https://example.test/avatar.png',
      });
      const avatarResponse = await uploadAvatar(ownerToken);
      expect(avatarResponse.status).toBe(200);
      const avatar = await avatarResponse.json() as { user: { avatarUrl: string } };
      expect(avatar.user.avatarUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/uploads\/avatars\/.+\.png$/);
      const savedAvatar = await fetch(avatar.user.avatarUrl);
      expect(savedAvatar.status).toBe(200);
      expect(savedAvatar.headers.get('content-type')).toBe('image/png');

      expect((await request(`/families/${family.id}/members/me`, memberToken)).status).toBe(200);
      expect(metadata.getMembership(family.id, member.id)).toBeNull();

      expect((await request(`/families/${family.id}/members/${admin.id}`, adminToken)).status).toBe(403);
      expect((await request(`/families/${family.id}`, adminToken)).status).toBe(403);
      expect((await request(`/families/${family.id}/members/${admin.id}`, ownerToken)).status).toBe(200);
      expect(metadata.getMembership(family.id, admin.id)).toBeNull();

      expect((await request(`/families/${family.id}/members/me`, ownerToken)).status).toBe(409);
      expect((await request(`/families/${family.id}`, ownerToken)).status).toBe(200);
      expect(metadata.getFamily(family.id)).toBeNull();
      await expect(readFile(inventory.inventoryPath(family.id), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      database.close();
    }
  });
});

function testConfig(root: string): AppConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    dataDir: root,
    databasePath: ':memory:',
    inventoryDir: path.join(root, 'families'),
    publicOrigin: '*',
    allowDevWechatLogin: true,
    encryptionKey: Buffer.alloc(32, 1),
    chatHistoryLimit: 20,
    agentConflictRetries: 0,
    llmTimeoutMs: 1_000,
    dayTimezoneOffsetMinutes: 480,
    dayBoundaryHour: 4,
  };
}
