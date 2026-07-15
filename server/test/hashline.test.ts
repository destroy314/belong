import { describe, expect, it } from 'vitest';

import {
  applyHashlineEdits,
  buildHashlineView,
  HashlineValidationError,
  InventoryConflictError,
} from '../src/hashline.js';

function hashFor(content: string, text: string): string {
  const line = buildHashlineView(content).lines.find((entry) => entry.text === text);
  if (!line) throw new Error(`Missing test line: ${text}`);
  return line.hash;
}

describe('Hashline editing', () => {
  it('creates stable, unique hashes for duplicate lines', () => {
    const content = '# 家\n\n- 数据线\n- 数据线\n';
    const first = buildHashlineView(content);
    const second = buildHashlineView(content);

    expect(first.version).toMatch(/^[a-f0-9]{64}$/);
    expect(first.lines.map((line) => line.hash)).toEqual(
      second.lines.map((line) => line.hash),
    );
    expect(new Set(first.lines.map((line) => line.hash)).size).toBe(
      first.lines.length,
    );
    expect(first.text).toContain('|# 家');
  });

  it('applies inserts, replacements and deletes against one snapshot', () => {
    const content = '# 家\n## 书房\n- 旧数据线\n- 说明书\n## 厨房\n- 杯子\n';
    const view = buildHashlineView(content);
    const result = applyHashlineEdits(content, view.version, [
      {
        type: 'replace',
        startHash: hashFor(content, '- 旧数据线'),
        endHash: hashFor(content, '- 旧数据线'),
        text: '- USB-C 数据线（2 根）',
      },
      {
        type: 'delete',
        startHash: hashFor(content, '- 说明书'),
        endHash: hashFor(content, '- 说明书'),
      },
      {
        type: 'insert_after',
        hash: hashFor(content, '- 杯子'),
        text: '- 保温壶\n- 餐垫',
      },
    ]);

    expect(result.content).toBe(
      '# 家\n## 书房\n- USB-C 数据线（2 根）\n## 厨房\n- 杯子\n- 保温壶\n- 餐垫\n',
    );
    expect(result.diff).toEqual({
      addedLines: 3,
      removedLines: 2,
      summary: '+3 -2',
    });
    expect(result.version).not.toBe(view.version);
  });

  it('preserves CRLF and final-newline style', () => {
    const content = '# 家\r\n- 钥匙';
    const view = buildHashlineView(content);
    const result = applyHashlineEdits(content, view.version, [
      {
        type: 'insert_before',
        hash: hashFor(content, '- 钥匙'),
        text: '## 玄关',
      },
    ]);

    expect(result.content).toBe('# 家\r\n## 玄关\r\n- 钥匙');
    expect(result.view.newline).toBe('\r\n');
    expect(result.view.finalNewline).toBe(false);
  });

  it('rejects a stale version before considering edits', () => {
    const content = '# 家\n';
    expect(() =>
      applyHashlineEdits(content, 'stale-version', [
        { type: 'insert_after', hash: 'unknown', text: '## 书房' },
      ]),
    ).toThrow(InventoryConflictError);
  });

  it('rejects unknown hashes and reversed or overlapping ranges', () => {
    const content = '# 家\n## 书房\n- A\n- B\n- C\n';
    const view = buildHashlineView(content);
    const a = hashFor(content, '- A');
    const b = hashFor(content, '- B');
    const c = hashFor(content, '- C');

    expect(() =>
      applyHashlineEdits(content, view.version, [
        { type: 'delete', startHash: 'ffffffff', endHash: 'ffffffff' },
      ]),
    ).toThrow(HashlineValidationError);
    expect(() =>
      applyHashlineEdits(content, view.version, [
        { type: 'delete', startHash: c, endHash: a },
      ]),
    ).toThrow(/startHash after endHash/);
    expect(() =>
      applyHashlineEdits(content, view.version, [
        { type: 'replace', startHash: a, endHash: b, text: '- AB' },
        { type: 'delete', startHash: b, endHash: c },
      ]),
    ).toThrow(/overlap/);
  });
});
