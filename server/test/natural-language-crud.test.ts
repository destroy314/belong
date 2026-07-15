import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InventoryAgent, type InventoryEdit } from '../src/agent.js';
import { InventoryStore, type InventorySnapshot } from '../src/inventory.js';
import type { CompleteResult, ToolCall } from '../src/llm.js';

const temporaryDirectories: string[] = [];
const llm = { baseUrl: 'https://example.test/v1', model: 'fake', apiKey: 'secret' };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('自然语言 CRUD 到真实 Markdown 编辑链路', () => {
  it('依次完成添加、移动、修改和删除，且不重写无关结构', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'belong-crud-'));
    temporaryDirectories.push(root);
    const familyId = 'family-crud';
    const familyDirectory = path.join(root, familyId);
    await mkdir(familyDirectory, { recursive: true });
    const original = [
      '# 家',
      '',
      '## 书房',
      '书房下午阳光很好。',
      '',
      '### 书桌',
      '- 相机',
      '- 蓝色数据线',
      '',
      '## 客厅',
      '',
      '### 电视柜',
      '- 遥控器',
      '',
    ].join('\n');
    await writeFile(path.join(familyDirectory, 'inventory.md'), original, 'utf8');
    const inventory = new InventoryStore(root);

    await runNaturalLanguageEdit(
      inventory,
      familyId,
      '把护照也放到书桌。',
      (snapshot) => [
        {
          type: 'insert_after',
          hash: hashFor(snapshot, '- 蓝色数据线'),
          text: '- 护照',
        },
      ],
    );
    await runNaturalLanguageEdit(
      inventory,
      familyId,
      '相机移到客厅电视柜。',
      (snapshot) => [
        {
          type: 'delete',
          startHash: hashFor(snapshot, '- 相机'),
          endHash: hashFor(snapshot, '- 相机'),
        },
        {
          type: 'insert_after',
          hash: hashFor(snapshot, '- 遥控器'),
          text: '- 相机',
        },
      ],
    );
    await runNaturalLanguageEdit(
      inventory,
      familyId,
      '把蓝色数据线改成 USB-C 数据线（2 根）。',
      (snapshot) => [
        {
          type: 'replace',
          startHash: hashFor(snapshot, '- 蓝色数据线'),
          endHash: hashFor(snapshot, '- 蓝色数据线'),
          text: '- USB-C 数据线（2 根）',
        },
      ],
    );
    await runNaturalLanguageEdit(
      inventory,
      familyId,
      '遥控器已经坏了，删掉它。',
      (snapshot) => [
        {
          type: 'delete',
          startHash: hashFor(snapshot, '- 遥控器'),
          endHash: hashFor(snapshot, '- 遥控器'),
        },
      ],
    );

    const final = await inventory.load(familyId);
    expect(final.content).toContain('书房下午阳光很好。');
    expect(final.content).toContain('### 书桌\n- USB-C 数据线（2 根）\n- 护照');
    expect(final.content).toContain('### 电视柜\n- 相机');
    expect(final.content).not.toContain('- 遥控器');
    expect(final.content).not.toContain('- 蓝色数据线');
  });
});

async function runNaturalLanguageEdit(
  inventory: InventoryStore,
  familyId: string,
  message: string,
  buildEdits: (snapshot: InventorySnapshot) => InventoryEdit[],
): Promise<void> {
  const before = await inventory.load(familyId);
  let round = 0;
  const complete = vi.fn(async (): Promise<CompleteResult> => {
    if (round++ === 0) {
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [editToolCall(before.version, buildEdits(before))],
        },
      };
    }
    return { message: { role: 'assistant', content: '已更新家庭库存。' } };
  });
  const agent = new InventoryAgent({
    inventory,
    clientFactory: () => ({ complete }),
  });
  const result = await agent.run({ familyId, message, history: [], llm });
  expect(result.changeSummary).toMatch(/^\+\d+ -\d+$/);
}

function hashFor(snapshot: InventorySnapshot, text: string): string {
  const line = snapshot.view.lines.find((candidate) => candidate.text === text);
  if (!line) throw new Error(`Missing line: ${text}`);
  return line.hash;
}

function editToolCall(version: string, edits: InventoryEdit[]): ToolCall {
  return {
    id: 'fake-edit',
    type: 'function',
    function: {
      name: 'edit_inventory',
      arguments: JSON.stringify({ version, edits }),
    },
  };
}
