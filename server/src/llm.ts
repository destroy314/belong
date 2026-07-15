export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  };
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface CompleteOptions {
  messages: ChatMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
}

export interface CompleteResult {
  message: ChatMessage;
  finishReason?: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

function completionUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new LlmError('LLM API 地址无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new LlmError('LLM API 地址必须是不含账号信息的 HTTP(S) URL');
  }
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/chat/completions')
    ? path
    : `${path}/chat/completions`;
  return url.toString();
}

function providerMessage(payload: unknown, apiKey: string): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return undefined;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return undefined;
  // 第三方错误只保留有限长度，且不将其写入日志。
  const withoutConfiguredKey = message.split(apiKey).join('[REDACTED]');
  return withoutConfiguredKey
    .replace(/\b(?:sk-|Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '[REDACTED]')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 300);
}

export class OpenAICompatibleClient {
  constructor(
    private readonly config: LlmConfig,
    private readonly timeoutMs = 60_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async complete(options: CompleteOptions): Promise<CompleteResult> {
    const response = await this.fetchImpl(completionUrl(this.config.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: options.messages,
        ...(options.tools?.length
          ? { tools: options.tools, tool_choice: 'auto', parallel_tool_calls: false }
          : {}),
        temperature: options.temperature ?? 0,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new LlmError('LLM 请求超时');
      }
      throw new LlmError('LLM 服务无法连接');
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new LlmError(
        response.ok ? 'LLM 返回了无效响应' : `LLM 请求失败 (${response.status})`,
        response.status,
      );
    }

    if (!response.ok) {
      const detail = providerMessage(payload, this.config.apiKey);
      throw new LlmError(
        detail ? `LLM 请求失败：${detail}` : `LLM 请求失败 (${response.status})`,
        response.status,
      );
    }

    const choice = (payload as {
      choices?: Array<{
        message?: ChatMessage;
        finish_reason?: string;
      }>;
    }).choices?.[0];
    if (!choice?.message || choice.message.role !== 'assistant') {
      throw new LlmError('LLM 响应缺少 assistant message');
    }
    const toolCalls = choice.message.tool_calls;
    if (toolCalls != null && !Array.isArray(toolCalls)) {
      throw new LlmError('LLM 返回了无效的工具调用');
    }
    return {
      message: {
        role: 'assistant',
        content:
          typeof choice.message.content === 'string' ? choice.message.content : null,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
      ...(choice.finish_reason ? { finishReason: choice.finish_reason } : {}),
    };
  }
}

export function validateLlmConfig(config: {
  baseUrl: unknown;
  model: unknown;
  apiKey?: unknown;
}): { baseUrl: string; model: string; apiKey?: string } {
  if (typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) {
    throw new Error('baseUrl 不能为空');
  }
  // 调用一次纯 URL 解析以复用相同校验规则。
  completionUrl(config.baseUrl.trim());
  if (typeof config.model !== 'string' || !config.model.trim()) {
    throw new Error('model 不能为空');
  }
  if (config.model.trim().length > 200) throw new Error('model 过长');
  if (config.apiKey != null && typeof config.apiKey !== 'string') {
    throw new Error('apiKey 必须是字符串');
  }
  const apiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : undefined;
  return {
    baseUrl: config.baseUrl.trim().replace(/\/+$/, ''),
    model: config.model.trim(),
    ...(apiKey ? { apiKey } : {}),
  };
}
