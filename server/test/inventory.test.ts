import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  InventoryConflictError,
  InventoryStore,
  parseInventoryMarkdown,
} from '../src/inventory.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('inventory Markdown', () => {
  it('parses headings, direct descriptions, items and complete paths', () => {
    const markdown = [
      '这是一份家庭库存。',
      '',
      '# 家',
      '',
      '## 书房',
      '',
      '### 书架',
      '书架有五排三列。',
      '',
      '#### 第三排第一列',
      '- 护照收纳盒',
      '* 相机说明书',
      '+ USB-C 数据线（2 根）',
      '',
      '### 书桌',
      '#### 左侧抽屉',
      '抽屉深处容易被前方物品遮挡。',
      '- 备用钥匙',
      '',
    ].join('\n');
    const parsed = parseInventoryMarkdown(markdown);
    const home = parsed.locations[0]!;
    const study = home.children[0]!;
    const shelf = study.children[0]!;
    const cell = shelf.children[0]!;
    const drawer = study.children[1]!.children[0]!;

    expect(parsed.preamble).toBe('这是一份家庭库存。');
    expect(shelf.description).toBe('书架有五排三列。');
    expect(cell.path).toEqual(['家', '书房', '书架', '第三排第一列']);
    expect(cell.items).toEqual([
      '护照收纳盒',
      '相机说明书',
      'USB-C 数据线（2 根）',
    ]);
    expect(drawer.description).toBe('抽屉深处容易被前方物品遮挡。');
    expect(drawer.items).toEqual(['备用钥匙']);
  });

  it('does not treat Markdown inside fenced notes as inventory structure', () => {
    const parsed = parseInventoryMarkdown(
      '# 家\n## 储藏室\n```md\n### 不是位置\n- 也不是物品\n```\n- 纸箱\n',
    );
    const room = parsed.locations[0]!.children[0]!;
    expect(room.children).toHaveLength(0);
    expect(room.items).toEqual(['纸箱']);
    expect(room.description).toContain('### 不是位置');
  });
});

describe('InventoryStore', () => {
  it('creates a readable default inventory lazily', async () => {
    const root = await newTemporaryDirectory();
    const store = new InventoryStore(root);
    const loaded = await store.load('family-1');

    expect(loaded.content).toBe('# 家\n');
    expect(loaded.document.locations[0]!.title).toBe('家');
    expect(await readFile(store.inventoryPath('family-1'), 'utf8')).toBe('# 家\n');
  });

  it('serializes concurrent updates so one stale writer fails', async () => {
    const root = await newTemporaryDirectory();
    const store = new InventoryStore(root);
    const familyDirectory = path.join(root, 'family-1');
    await mkdir(familyDirectory, { recursive: true });
    await writeFile(
      path.join(familyDirectory, 'inventory.md'),
      '# 家\n## 玄关\n- 钥匙\n',
      'utf8',
    );
    const snapshot = await store.load('family-1');
    const anchor = snapshot.view.lines.find((line) => line.text === '- 钥匙')!;
    const first = store.apply('family-1', snapshot.version, [
      { type: 'insert_after', hash: anchor.hash, text: '- 口罩' },
    ]);
    const second = store.apply('family-1', snapshot.version, [
      { type: 'insert_after', hash: anchor.hash, text: '- 雨伞' },
    ]);

    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(InventoryConflictError),
    });
    const finalContent = await readFile(store.inventoryPath('family-1'), 'utf8');
    expect(finalContent.includes('- 口罩') || finalContent.includes('- 雨伞')).toBe(true);
    expect(finalContent.includes('- 口罩') && finalContent.includes('- 雨伞')).toBe(false);
  });

  it('rejects path traversal in family ids', async () => {
    const store = new InventoryStore(await newTemporaryDirectory());
    await expect(store.load('../escape')).rejects.toThrow('Invalid family id');
  });

  it('removes every inventory file when a family is deleted', async () => {
    const root = await newTemporaryDirectory();
    const store = new InventoryStore(root);
    await store.load('family-1');

    await store.deleteFamily('family-1');
    await expect(readFile(store.inventoryPath('family-1'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

async function newTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'belong-inventory-'));
  temporaryDirectories.push(directory);
  return directory;
}
