import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_DEVELOPMENT_INVENTORY,
  createDevelopmentFamily,
  developmentFamilyInputFromArgs,
} from '../src/create-dev-family.js';
import type { AppConfig } from '../src/config.js';
import { createDatabase, MetadataStore } from '../src/db.js';
import { decryptSecret } from '../src/security.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('createDevelopmentFamily', () => {
  it('creates a family with encrypted API Key and sample inventory', async () => {
    const directory = await temporaryDirectory();
    const config = testConfig(directory);
    const created = await createDevelopmentFamily(config, {
      name: '联调家庭',
      ownerOpenid: 'dev-owner',
      ownerNickname: '开发者',
      baseUrl: 'https://api.example.test/v1',
      model: 'test-model',
      apiKey: 'sk-test-private-key',
    });

    const database = createDatabase(config.databasePath);
    const stored = new MetadataStore(database).getLlmConfig(created.family.id)!;
    expect(decryptSecret(stored.apiKeyEncrypted!, config.encryptionKey, `family-llm:${created.family.id}`)).toBe(
      'sk-test-private-key',
    );
    database.close();

    expect(await readFile(path.join(config.inventoryDir, created.family.id, 'inventory.md'), 'utf8')).toBe(
      DEFAULT_DEVELOPMENT_INVENTORY,
    );
    expect(created.owner.nickname).toBe('开发者');
  });

  it('accepts command options and falls back to LLM environment variables', () => {
    expect(
      developmentFamilyInputFromArgs(['--name', '命令行家庭'], {
        LLM_BASE_URL: 'https://api.example.test/v1',
        LLM_MODEL: 'test-model',
        LLM_API_KEY: 'sk-from-env',
      }),
    ).toMatchObject({
      name: '命令行家庭',
      ownerOpenid: 'belong-dev-owner',
      baseUrl: 'https://api.example.test/v1',
      model: 'test-model',
      apiKey: 'sk-from-env',
    });
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'belong-create-dev-family-'));
  temporaryDirectories.push(directory);
  return directory;
}

function testConfig(directory: string): AppConfig {
  return {
    port: 3000,
    host: '127.0.0.1',
    dataDir: directory,
    databasePath: path.join(directory, 'belong.sqlite'),
    inventoryDir: path.join(directory, 'families'),
    publicOrigin: '*',
    allowDevWechatLogin: true,
    encryptionKey: Buffer.alloc(32, 1),
    chatHistoryLimit: 20,
    agentConflictRetries: 2,
    llmTimeoutMs: 60_000,
    dayTimezoneOffsetMinutes: 480,
    dayBoundaryHour: 4,
  };
}
