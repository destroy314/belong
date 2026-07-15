import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InventoryAgent } from '../src/agent.js';
import { InventoryStore } from '../src/inventory.js';
import type { CompleteOptions, CompleteResult, ToolCall } from '../src/llm.js';

const temporaryDirectories: string[] = [];
const llm = {
  baseUrl: 'https://example.test/v1',
  model: 'scripted-test-model',
  apiKey: 'test-only',
};

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('自然语言库存 CRUD 编排', () => {
  it('依次添加、移动、改名和删除，并始终局部编辑 inventory.md', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belong-agent-crud-'));
    temporaryDirectories.push(root);
    const familyId = 'family-crud';
    const familyDirectory = path.join(root, familyId);
    await mkdir(familyDirectory, { recursive: true });
    await writeFile(
      path.join(familyDirectory, 'inventory.md'),
      [
        '# 家',
        '',
        '## 书房',
        '### 书桌',
        '- 备用钥匙',
        '',
        '## 玄关',
        '### 抽屉',
        '',
      ].join('\n'),
      'utf8',
    );

    const inventory = new InventoryStore(root);
    const complete = vi.fn(scriptedCrudCompletion);
    const agent = new InventoryAgent({
      inventory,
      clientFactory: () => ({ complete }),
    });

    const commands = [
      '在书房书桌添加护照',
      '把备用钥匙移到玄关抽屉',
      '把护照改名为护照收纳盒',
      '删除护照收纳盒',
    ];
    for (const message of commands) {
      const result = await agent.run({
        familyId,
        message,
        history: [],
        llm,
      });
      expect(result.changeSummary).toMatch(/^\+\d+ -\d+$/);
    }

    const final = await inventory.load(familyId);
    expect(final.content).toContain('### 抽屉\n- 备用钥匙');
    expect(final.content).not.toContain('### 书桌\n- 备用钥匙');
    expect(final.content).not.toContain('护照');
    expect(complete).toHaveBeenCalledTimes(commands.length * 2);
  });
});

async function scriptedCrudCompletion(
  options: CompleteOptions,
): Promise<CompleteResult> {
  const last = options.messages.at(-1);
  if (last?.role === 'tool') {
    return { message: { role: 'assistant', content: '库存已按要求更新。' } };
  }

  const system = options.messages[0]?.content;
  const user = [...options.messages]
    .reverse()
    .find((message) => message.role === 'user')?.content;
  if (typeof system !== 'string' || typeof user !== 'string') {
    throw new Error('测试 Agent 缺少系统库存或用户消息');
  }
  const version = system.match(/当前库存版本：([a-f0-9]{64})/)?.[1];
  if (!version) throw new Error('系统提示缺少库存版本');

  const edits = user.includes('添加护照')
    ? [{ type: 'insert_after', hash: hashFor(system, '- 备用钥匙'), text: '- 护照' }]
    : user.includes('移到玄关抽屉')
      ? [
          {
            type: 'delete',
            startHash: hashFor(system, '- 备用钥匙'),
            endHash: hashFor(system, '- 备用钥匙'),
          },
          {
            type: 'insert_after',
            hash: hashFor(system, '### 抽屉'),
            text: '- 备用钥匙',
          },
        ]
      : user.includes('改名为护照收纳盒')
        ? [
            {
              type: 'replace',
              startHash: hashFor(system, '- 护照'),
              endHash: hashFor(system, '- 护照'),
              text: '- 护照收纳盒',
            },
          ]
        : user.includes('删除护照收纳盒')
          ? [
              {
                type: 'delete',
                startHash: hashFor(system, '- 护照收纳盒'),
                endHash: hashFor(system, '- 护照收纳盒'),
              },
            ]
          : undefined;
  if (!edits) throw new Error(`测试未覆盖的命令：${user}`);

  const call: ToolCall = {
    id: `call-${user}`,
    type: 'function',
    function: {
      name: 'edit_inventory',
      arguments: JSON.stringify({ version, edits }),
    },
  };
  return {
    message: { role: 'assistant', content: null, tool_calls: [call] },
  };
}

function hashFor(systemPrompt: string, exactLine: string): string {
  const hashline = systemPrompt
    .split('\n')
    .find((line) => line.slice(line.indexOf('|') + 1) === exactLine);
  const hash = hashline?.match(/^([a-f0-9]+)\|/)?.[1];
  if (!hash) throw new Error(`当前 Hashline 视图中找不到：${exactLine}`);
  return hash;
}

