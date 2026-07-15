import type { ChatMessage, LlmConfig, ToolCall } from './llm.js';
import { OpenAICompatibleClient } from './llm.js';
import { buildInventorySystemPrompt, INVENTORY_EDIT_TOOL } from './prompt.js';

export type InventoryEdit =
  | { type: 'insert_before' | 'insert_after'; hash: string; text: string }
  | { type: 'replace'; startHash: string; endHash: string; text: string }
  | { type: 'delete'; startHash: string; endHash: string };

export interface InventorySnapshot {
  content: string;
  version: string;
  view: string | { text: string };
  diff?: {
    added?: number;
    removed?: number;
    addedLines?: number;
    removedLines?: number;
    summary?: string;
  };
}

export interface InventoryGateway {
  load(familyId: string): Promise<InventorySnapshot> | InventorySnapshot;
  apply(
    familyId: string,
    expectedVersion: string,
    edits: InventoryEdit[],
  ): Promise<InventorySnapshot> | InventorySnapshot;
}

export interface AgentHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface RunAgentInput {
  familyId: string;
  message: string;
  history: AgentHistoryMessage[];
  llm: LlmConfig;
  userNickname?: string | null;
}

export interface RunAgentResult {
  reply: string;
  inventoryVersion: string;
  changeSummary?: string;
}

export class AgentProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentProtocolError';
  }
}

class RetryConflictError extends Error {}

interface ParsedEditCall {
  version: string;
  edits: InventoryEdit[];
}

const HASH_PATTERN = /^[a-f0-9]{4,32}$/i;

function object(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(
  value: unknown,
  field: string,
  options: { max?: number; hash?: boolean } = {},
): string {
  if (typeof value !== 'string' || !value || value.length > (options.max ?? 100_000)) {
    throw new AgentProtocolError(`LLM 工具参数 ${field} 无效`);
  }
  if (options.hash && !HASH_PATTERN.test(value)) {
    throw new AgentProtocolError(`LLM 工具参数 ${field} 不是有效行哈希`);
  }
  return value;
}

export function parseInventoryEditCall(toolCall: ToolCall): ParsedEditCall {
  if (toolCall.type !== 'function' || toolCall.function.name !== 'edit_inventory') {
    throw new AgentProtocolError('LLM 请求了未允许的工具');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(toolCall.function.arguments);
  } catch {
    throw new AgentProtocolError('LLM 返回的工具参数不是有效 JSON');
  }
  const args = object(raw);
  if (!args) throw new AgentProtocolError('LLM 工具参数无效');
  const version = requiredString(args.version, 'version', { max: 200 });
  if (!Array.isArray(args.edits) || args.edits.length < 1 || args.edits.length > 20) {
    throw new AgentProtocolError('LLM 工具参数 edits 无效');
  }
  const edits = args.edits.map((candidate, index): InventoryEdit => {
    const edit = object(candidate);
    if (!edit || typeof edit.type !== 'string') {
      throw new AgentProtocolError(`LLM 工具参数 edits[${index}] 无效`);
    }
    if (edit.type === 'insert_before' || edit.type === 'insert_after') {
      return {
        type: edit.type,
        hash: requiredString(edit.hash, `edits[${index}].hash`, { hash: true }),
        text: requiredString(edit.text, `edits[${index}].text`),
      };
    }
    if (edit.type === 'replace') {
      return {
        type: edit.type,
        startHash: requiredString(edit.startHash, `edits[${index}].startHash`, {
          hash: true,
        }),
        endHash: requiredString(edit.endHash, `edits[${index}].endHash`, {
          hash: true,
        }),
        text: requiredString(edit.text, `edits[${index}].text`),
      };
    }
    if (edit.type === 'delete') {
      return {
        type: edit.type,
        startHash: requiredString(edit.startHash, `edits[${index}].startHash`, {
          hash: true,
        }),
        endHash: requiredString(edit.endHash, `edits[${index}].endHash`, {
          hash: true,
        }),
      };
    }
    throw new AgentProtocolError(`未知的库存编辑类型：${edit.type}`);
  });
  return { version, edits };
}

function hashlineText(view: InventorySnapshot['view']): string {
  return typeof view === 'string' ? view : view.text;
}

function formatDiff(diff: InventorySnapshot['diff']): string | undefined {
  if (!diff) return undefined;
  if (typeof diff.summary === 'string' && /^\+\d+\s+-\d+$/.test(diff.summary)) {
    return diff.summary;
  }
  const rawAdded = diff.added ?? diff.addedLines;
  const rawRemoved = diff.removed ?? diff.removedLines;
  const added = Number.isSafeInteger(rawAdded) && rawAdded! >= 0 ? rawAdded! : 0;
  const removed = Number.isSafeInteger(rawRemoved) && rawRemoved! >= 0 ? rawRemoved! : 0;
  return `+${added} -${removed}`;
}

export interface InventoryAgentOptions {
  inventory: InventoryGateway;
  timeoutMs?: number;
  conflictRetries?: number;
  maxToolRounds?: number;
  isConflictError?: (error: unknown) => boolean;
  clientFactory?: (
    config: LlmConfig,
    timeoutMs: number,
  ) => Pick<OpenAICompatibleClient, 'complete'>;
}

export class InventoryAgent {
  private readonly timeoutMs: number;
  private readonly conflictRetries: number;
  private readonly maxToolRounds: number;
  private readonly isConflictError: (error: unknown) => boolean;
  private readonly clientFactory: (
    config: LlmConfig,
    timeoutMs: number,
  ) => Pick<OpenAICompatibleClient, 'complete'>;

  constructor(private readonly options: InventoryAgentOptions) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.conflictRetries = options.conflictRetries ?? 2;
    this.maxToolRounds = options.maxToolRounds ?? 3;
    this.isConflictError =
      options.isConflictError ??
      ((error) =>
        error instanceof Error &&
        ['InventoryConflictError', 'HashlineValidationError'].includes(error.name));
    this.clientFactory =
      options.clientFactory ??
      ((config, timeoutMs) => new OpenAICompatibleClient(config, timeoutMs));
  }

  async run(input: RunAgentInput): Promise<RunAgentResult> {
    const message = input.message.trim();
    if (!message) throw new Error('消息不能为空');
    if (message.length > 4_000) throw new Error('消息过长');

    for (let attempt = 0; attempt <= this.conflictRetries; attempt += 1) {
      try {
        return await this.runOnce({ ...input, message }, attempt > 0);
      } catch (error) {
        if (!(error instanceof RetryConflictError) || attempt === this.conflictRetries) {
          throw error;
        }
      }
    }
    throw new Error('库存编辑冲突');
  }

  private async runOnce(input: RunAgentInput, retried: boolean): Promise<RunAgentResult> {
    let snapshot = await this.options.inventory.load(input.familyId);
    const client = this.clientFactory(input.llm, this.timeoutMs);
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content:
          buildInventorySystemPrompt(
            snapshot.version,
            hashlineText(snapshot.view),
            input.userNickname,
          ) +
          (retried
            ? '\n\n注意：库存在上一次尝试期间已变更，你必须只依据这份最新视图重新判断。'
            : ''),
      },
      ...input.history.map((item) => ({ role: item.role, content: item.content }) as ChatMessage),
      { role: 'user', content: input.message },
    ];
    let changeSummary: string | undefined;
    let changed = false;

    for (let round = 0; round <= this.maxToolRounds; round += 1) {
      const completion = await client.complete({
        messages,
        tools: [INVENTORY_EDIT_TOOL],
        temperature: 0,
      });
      const toolCalls = completion.message.tool_calls ?? [];

      if (toolCalls.length === 0) {
        const reply = completion.message.content?.trim();
        if (!reply) {
          if (changed) {
            return {
              reply: '已更新家庭库存。',
              inventoryVersion: snapshot.version,
              ...(changeSummary ? { changeSummary } : {}),
            };
          }
          throw new AgentProtocolError('LLM 未返回可用内容');
        }
        return {
          reply,
          inventoryVersion: snapshot.version,
          ...(changeSummary ? { changeSummary } : {}),
        };
      }

      if (toolCalls.length !== 1) {
        throw new AgentProtocolError('每轮只允许一次库存编辑工具调用');
      }
      if (round === this.maxToolRounds) {
        throw new AgentProtocolError('LLM 工具调用次数过多');
      }

      const toolCall = toolCalls[0]!;
      const parsed = parseInventoryEditCall(toolCall);
      if (parsed.version !== snapshot.version) {
        throw new RetryConflictError();
      }
      let updated: InventorySnapshot;
      try {
        updated = await this.options.inventory.apply(
          input.familyId,
          parsed.version,
          parsed.edits,
        );
      } catch (error) {
        if (this.isConflictError(error)) throw new RetryConflictError();
        throw error;
      }
      changed = true;
      snapshot = updated;
      changeSummary = formatDiff(updated.diff) ?? changeSummary;
      messages[0] = {
        role: 'system',
        content: buildInventorySystemPrompt(
          snapshot.version,
          hashlineText(snapshot.view),
          input.userNickname,
        ),
      };
      messages.push(completion.message);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify({
          ok: true,
          version: snapshot.version,
          ...(changeSummary ? { changeSummary } : {}),
        }),
      });
    }

    throw new AgentProtocolError('Agent 未能完成请求');
  }
}
