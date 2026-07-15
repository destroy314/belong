import { describe, expect, it, vi } from 'vitest';
import {
  AgentProtocolError,
  InventoryAgent,
  parseInventoryEditCall,
  type InventoryEdit,
  type InventoryGateway,
  type InventorySnapshot,
} from '../src/agent.js';
import type { CompleteOptions, CompleteResult, ToolCall } from '../src/llm.js';

const llm = { baseUrl: 'https://example.com/v1', model: 'test', apiKey: 'secret' };

function toolCall(arguments_: unknown): ToolCall {
  return {
    id: 'call_1',
    type: 'function',
    function: { name: 'edit_inventory', arguments: JSON.stringify(arguments_) },
  };
}

describe('parseInventoryEditCall', () => {
  it('只接受小型原子编辑', () => {
    expect(
      parseInventoryEditCall(
        toolCall({
          version: 'version-1',
          edits: [{ type: 'insert_after', hash: 'a81f1234', text: '- 护照' }],
        }),
      ),
    ).toEqual({
      version: 'version-1',
      edits: [{ type: 'insert_after', hash: 'a81f1234', text: '- 护照' }],
    });
  });

  it('拒绝未知哈希形式', () => {
    expect(() =>
      parseInventoryEditCall(
        toolCall({
          version: 'version-1',
          edits: [{ type: 'delete', startHash: 'line 1', endHash: 'line 2' }],
        }),
      ),
    ).toThrow(AgentProtocolError);
  });
});

describe('InventoryAgent', () => {
  it('查询时把完整 Hashline 库存放入系统上下文', async () => {
    const snapshot: InventorySnapshot = {
      content: '# 家\n- 钥匙\n',
      version: 'v1',
      view: { text: 'a81f1234|# 家\nd0341234|- 钥匙' },
    };
    const inventory: InventoryGateway = {
      load: vi.fn(() => snapshot),
      apply: vi.fn(),
    };
    const complete = vi.fn(async (options: CompleteOptions): Promise<CompleteResult> => {
      expect(options.messages[0]?.content).toContain('a81f1234|# 家');
      expect(options.messages[0]?.content).toContain('小满');
      expect(options.messages.at(-1)).toEqual({ role: 'user', content: '钥匙在哪？' });
      return { message: { role: 'assistant', content: '钥匙记录在：家。' } };
    });
    const agent = new InventoryAgent({
      inventory,
      clientFactory: () => ({ complete }),
    });

    await expect(
      agent.run({
        familyId: 'f1',
        message: '钥匙在哪？',
        history: [],
        llm,
        userNickname: '小满',
      }),
    ).resolves.toEqual({ reply: '钥匙记录在：家。', inventoryVersion: 'v1' });
    expect(inventory.apply).not.toHaveBeenCalled();
  });

  it('工具编辑后返回变更摘要', async () => {
    const first: InventorySnapshot = {
      content: '# 家\n',
      version: 'v1',
      view: 'a81f1234|# 家',
    };
    const second: InventorySnapshot = {
      content: '# 家\n- 护照\n',
      version: 'v2',
      view: 'a81f1234|# 家\nd0341234|- 护照',
      diff: { addedLines: 1, removedLines: 0, summary: '+1 -0' },
    };
    const apply = vi.fn(
      (_familyId: string, _version: string, _edits: InventoryEdit[]) => second,
    );
    const inventory: InventoryGateway = { load: () => first, apply };
    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            toolCall({
              version: 'v1',
              edits: [{ type: 'insert_after', hash: 'a81f1234', text: '- 护照' }],
            }),
          ],
        },
      })
      .mockResolvedValueOnce({
        message: { role: 'assistant', content: '已把护照记录在家中。' },
      });
    const agent = new InventoryAgent({
      inventory,
      clientFactory: () => ({ complete }),
    });

    await expect(
      agent.run({ familyId: 'f1', message: '记录护照', history: [], llm }),
    ).resolves.toEqual({
      reply: '已把护照记录在家中。',
      inventoryVersion: 'v2',
      changeSummary: '+1 -0',
    });
    expect(apply).toHaveBeenCalledWith('f1', 'v1', [
      { type: 'insert_after', hash: 'a81f1234', text: '- 护照' },
    ]);
  });

  it('遇到并发冲突会重载最新库存再让 Agent 判断', async () => {
    const snapshots: InventorySnapshot[] = [
      { content: '# 家\n', version: 'v1', view: 'a81f1234|# 家' },
      { content: '# 家\n- 相机\n', version: 'v2', view: 'bbcc1234|# 家\ndddd1234|- 相机' },
    ];
    let loadCount = 0;
    const conflict = Object.assign(new Error('conflict'), { name: 'InventoryConflictError' });
    const apply = vi
      .fn()
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({
        content: '# 家\n- 相机\n- 护照\n',
        version: 'v3',
        view: 'bbcc1234|# 家\ndddd1234|- 相机\neeee1234|- 护照',
        diff: { addedLines: 1, removedLines: 0, summary: '+1 -0' },
      });
    const inventory: InventoryGateway = {
      load: () => snapshots[Math.min(loadCount++, 1)]!,
      apply,
    };
    let attempt = 0;
    const agent = new InventoryAgent({
      inventory,
      conflictRetries: 1,
      clientFactory: () => {
        const thisAttempt = attempt++;
        let round = 0;
        return {
          complete: vi.fn(async () => {
            if (round++ === 0) {
              return {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    toolCall({
                      version: thisAttempt === 0 ? 'v1' : 'v2',
                      edits: [
                        {
                          type: 'insert_after',
                          hash: thisAttempt === 0 ? 'a81f1234' : 'dddd1234',
                          text: '- 护照',
                        },
                      ],
                    }),
                  ],
                },
              };
            }
            return { message: { role: 'assistant', content: '已记录护照。' } };
          }),
        };
      },
    });

    const result = await agent.run({
      familyId: 'f1',
      message: '加入护照',
      history: [],
      llm,
    });
    expect(result.inventoryVersion).toBe('v3');
    expect(loadCount).toBe(2);
    expect(apply).toHaveBeenCalledTimes(2);
  });
});
