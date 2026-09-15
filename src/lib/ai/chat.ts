/**
 * Multi-turn model calls, with tools.
 *
 * `index.ts` covers the shape the pipeline has always needed: one system
 * prompt, one user prompt, one answer. An agent that browses needs the other
 * shape — a conversation that accumulates, where the model may ask for a tool
 * instead of answering and then gets to see what came back.
 *
 * The awkward part is that "tool call" has two spellings in the wild. Workers
 * AI returns `tool_calls: [{ name, arguments }]` with the arguments already
 * parsed; the OpenAI-shaped models return `[{ id, function: { name,
 * arguments } }]` with the arguments as a JSON string. Rather than pick one
 * and hope, `readToolCalls` accepts both and hands back one normalised shape,
 * so the loop in `src/lib/agent/loop.ts` never has to care which model it is
 * talking to.
 *
 * Nothing here throws. A model that will not answer is a failed step, and a
 * failed step is something the loop reports and recovers from.
 */

import { MODELS, type AiResult } from './index';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** The tool's name, on a `tool` message. */
  name?: string;
  /** Echoed back so a model that tracks call ids can match them up. */
  tool_call_id?: string;
  /** Raw provider-shaped calls, carried on an assistant turn. */
  tool_calls?: unknown;
}

/** A tool as the model sees it: a name, a sentence, and a JSON Schema. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatTurn {
  /** Whatever the model said in prose. Often empty when it called a tool. */
  text: string;
  toolCalls: ToolCall[];
  /** The untouched response, so usage can be read off it. */
  raw: unknown;
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Ask for one turn of a conversation.
 *
 * The model may answer, or call tools, or — annoyingly often — do both. All
 * three are a successful turn; deciding what to do about them is the loop's
 * job.
 */
export async function chat(ai: Ai, options: ChatOptions): Promise<AiResult<ChatTurn>> {
  const payload: Record<string, unknown> = {
    messages: options.messages.map(toWire),
    max_tokens: options.maxTokens ?? 1024,
    temperature: options.temperature ?? 0.3,
  };

  if (options.tools?.length) {
    payload.tools = options.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  try {
    const response = await ai.run(
      (options.model ?? MODELS.tools) as Parameters<Ai['run']>[0],
      payload as never,
    );

    const turn = readTurn(response);
    if (!turn.text && turn.toolCalls.length === 0) {
      return { ok: false, error: 'The model returned neither an answer nor a tool call.' };
    }
    return { ok: true, data: turn };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/**
 * A message in the shape the provider expects.
 *
 * Tool results go back as a `tool` role with the name attached. Models that
 * do not recognise that role read it as context, which is worse but not
 * wrong — the content still says which tool produced it.
 */
function toWire(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.name) wire.name = message.name;
  if (message.tool_call_id) wire.tool_call_id = message.tool_call_id;
  if (message.tool_calls) wire.tool_calls = message.tool_calls;
  return wire;
}

export function readTurn(response: unknown): ChatTurn {
  if (typeof response === 'string') {
    return { text: response.trim(), toolCalls: [], raw: response };
  }

  const body = (response ?? {}) as Record<string, unknown>;
  const nested = body.response;

  // Some models answer with a string in `response`, others with an object
  // that carries the tool calls. Both end up here.
  const text =
    typeof nested === 'string'
      ? nested
      : typeof body.result === 'string'
        ? body.result
        : typeof (nested as Record<string, unknown> | undefined)?.response === 'string'
          ? String((nested as Record<string, unknown>).response)
          : '';

  return {
    text: text.trim(),
    toolCalls: readToolCalls(response),
    raw: response,
  };
}

/**
 * Pull tool calls out of a response, whichever spelling it used.
 *
 * A call whose arguments will not parse is dropped rather than passed on as
 * `{}`: an empty argument object looks like a deliberate call with no
 * parameters, and a tool running on that is a worse outcome than the loop
 * noticing the model produced nothing usable.
 */
export function readToolCalls(response: unknown): ToolCall[] {
  if (!response || typeof response !== 'object') return [];
  const body = response as Record<string, unknown>;

  const candidates =
    (Array.isArray(body.tool_calls) && body.tool_calls) ||
    (body.response &&
      typeof body.response === 'object' &&
      Array.isArray((body.response as Record<string, unknown>).tool_calls) &&
      ((body.response as Record<string, unknown>).tool_calls as unknown[])) ||
    [];

  const calls: ToolCall[] = [];

  for (const [index, candidate] of (candidates as unknown[]).entries()) {
    if (!candidate || typeof candidate !== 'object') continue;
    const row = candidate as Record<string, unknown>;
    const fn = (row.function ?? row) as Record<string, unknown>;

    const name = typeof fn.name === 'string' ? fn.name : '';
    if (!name) continue;

    const rawArgs = fn.arguments ?? fn.parameters ?? {};
    let args: Record<string, unknown> | null = null;

    if (typeof rawArgs === 'string') {
      try {
        const parsed = JSON.parse(rawArgs) as unknown;
        args = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      } catch {
        args = null;
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs as Record<string, unknown>;
    }

    if (!args) continue;

    calls.push({
      id: typeof row.id === 'string' && row.id ? row.id : `call_${index}`,
      name,
      arguments: args,
    });
  }

  return calls;
}
