import { describe, expect, it } from 'vitest';
import { runLoop, MAX_CALLS_PER_TURN, type LoopStep } from '~/lib/agent/loop';
import type { ToolContext, ToolDefinition } from '~/lib/agent/tools';
import { dedupeSources, firstSentences } from '~/lib/agent/research';

/**
 * A model that answers from a script.
 *
 * Each entry is one turn. The loop's contract is that it keeps going while
 * turns carry tool calls and stops when one does not, so a script is enough
 * to test every branch without a network.
 */
function scriptedAi(turns: unknown[]): { ai: Ai; calls: unknown[] } {
  const calls: unknown[] = [];
  let index = 0;

  const ai = {
    run: async (_model: string, payload: unknown) => {
      calls.push(payload);
      const turn = turns[Math.min(index, turns.length - 1)];
      index++;
      return turn;
    },
  } as unknown as Ai;

  return { ai, calls };
}

function toolThatAnswers(name: string, output: string, record?: string[]): ToolDefinition {
  return {
    spec: { name, description: 'test tool', parameters: { type: 'object', properties: {} } },
    async run(_ctx, args) {
      record?.push(JSON.stringify(args));
      return { ok: true, output };
    },
  };
}

// The loop passes this straight through to the tools, which are stubs here.
const context = {} as ToolContext;

// `record` in usage.ts is wrapped in its own try/catch, so a database that
// throws on the first property access costs a swallowed error and nothing
// else — which is exactly the guarantee that file claims to make.
const usage = { db: {} as never, userId: 'user_1', operation: 'test' };

describe('the agent loop', () => {
  it('answers straight away when the model does not need a tool', async () => {
    const { ai } = scriptedAi([{ response: 'They close on Mondays.' }]);

    const result = await runLoop({
      ai,
      system: 'system',
      task: 'when do they close?',
      tools: [toolThatAnswers('web_search', 'nothing')],
      toolContext: context,
      usage,
    });

    expect(result.ok).toBe(true);
    expect(result.answer).toBe('They close on Mondays.');
    expect(result.toolCalls).toBe(0);
  });

  it('runs a tool, shows the model what came back, and then answers', async () => {
    const { ai, calls } = scriptedAi([
      { response: '', tool_calls: [{ name: 'web_search', arguments: { query: 'wells coffee' } }] },
      { response: 'They roast on Tuesdays.' },
    ]);

    const result = await runLoop({
      ai,
      system: 'system',
      task: 'what do they do?',
      tools: [toolThatAnswers('web_search', '1. Wells Coffee — roasts on Tuesdays')],
      toolContext: context,
      usage,
    });

    expect(result.answer).toBe('They roast on Tuesdays.');
    expect(result.toolCalls).toBe(1);

    // The observation must actually reach the second turn, or the loop is
    // just an expensive way to ask twice.
    const second = calls[1] as { messages: Array<{ role: string; content: string }> };
    const observation = second.messages.find((message) => message.role === 'tool');
    expect(observation?.content).toContain('roasts on Tuesdays');

    const kinds = result.steps.map((step) => step.kind);
    expect(kinds).toContain('tool');
    expect(kinds).toContain('observation');
    expect(kinds).toContain('answer');
  });

  it('does not run the same call twice', async () => {
    const seen: string[] = [];
    const { ai } = scriptedAi([
      { response: '', tool_calls: [{ name: 'web_search', arguments: { query: 'same' } }] },
      { response: '', tool_calls: [{ name: 'web_search', arguments: { query: 'same' } }] },
      { response: 'Right, I already had that.' },
    ]);

    const result = await runLoop({
      ai,
      system: 'system',
      task: 'go round in circles',
      tools: [toolThatAnswers('web_search', 'a result', seen)],
      toolContext: context,
      usage,
      maxSteps: 6,
    });

    expect(seen).toHaveLength(1);
    expect(result.answer).toBe('Right, I already had that.');

    const repeat = result.steps.find((step) => step.kind === 'observation' && !step.ok);
    expect(repeat?.output).toContain('already called');
  });

  it('honours only the first few calls of a turn that asks for everything at once', async () => {
    const seen: string[] = [];
    const { ai } = scriptedAi([
      {
        response: '',
        tool_calls: Array.from({ length: 6 }, (_, index) => ({
          name: 'web_search',
          arguments: { query: `query ${index}` },
        })),
      },
      { response: 'Done.' },
    ]);

    await runLoop({
      ai,
      system: 'system',
      task: 'ask for everything',
      tools: [toolThatAnswers('web_search', 'a result', seen)],
      toolContext: context,
      usage,
      maxSteps: 10,
    });

    expect(seen).toHaveLength(MAX_CALLS_PER_TURN);
  });

  it('stops at the budget and makes the model answer from what it has', async () => {
    let turn = 0;
    const ai = {
      run: async (_model: string, payload: unknown) => {
        turn++;
        const body = payload as { tools?: unknown[] };
        // The closing turn is the one offered no tools at all.
        if (!body.tools) return { response: 'Partial, but here is what I found.' };
        return { response: '', tool_calls: [{ name: 'web_search', arguments: { query: `q${turn}` } }] };
      },
    } as unknown as Ai;

    const result = await runLoop({
      ai,
      system: 'system',
      task: 'never stop',
      tools: [toolThatAnswers('web_search', 'a result')],
      toolContext: context,
      usage,
      maxSteps: 3,
    });

    expect(result.toolCalls).toBe(3);
    expect(result.answer).toBe('Partial, but here is what I found.');
  });

  it('reports an unknown tool back to the model rather than throwing', async () => {
    const { ai } = scriptedAi([
      { response: '', tool_calls: [{ name: 'read_my_email', arguments: {} }] },
      { response: 'Understood, I will use what I have.' },
    ]);

    const result = await runLoop({
      ai,
      system: 'system',
      task: 'try something that does not exist',
      tools: [toolThatAnswers('web_search', 'a result')],
      toolContext: context,
      usage,
    });

    const observation = result.steps.find((step) => step.kind === 'observation');
    expect(observation?.output).toContain('no tool called');
    expect(result.answer).toBe('Understood, I will use what I have.');
  });

  it('keeps a tool that throws inside the loop', async () => {
    const exploding: ToolDefinition = {
      spec: { name: 'open_page', description: 'x', parameters: { type: 'object', properties: {} } },
      async run() {
        throw new Error('the site hung up');
      },
    };

    const { ai } = scriptedAi([
      { response: '', tool_calls: [{ name: 'open_page', arguments: { url: 'https://x.test' } }] },
      { response: 'That site would not load.' },
    ]);

    const result = await runLoop({
      ai,
      system: 'system',
      task: 'open a broken site',
      tools: [exploding],
      toolContext: context,
      usage,
    });

    expect(result.answer).toBe('That site would not load.');
    expect(result.steps.some((step) => step.output.includes('the site hung up'))).toBe(true);
  });

  it('hands every step to the caller as it happens', async () => {
    const streamed: LoopStep[] = [];
    const { ai } = scriptedAi([
      { response: 'thinking', tool_calls: [{ name: 'web_search', arguments: { query: 'x' } }] },
      { response: 'An answer.' },
    ]);

    await runLoop({
      ai,
      system: 'system',
      task: 'stream to me',
      tools: [toolThatAnswers('web_search', 'a result')],
      toolContext: context,
      usage,
      onStep: (step) => {
        streamed.push(step);
      },
    });

    // Indexes must be dense and ordered, because they are what the run page
    // sorts the transcript by.
    expect(streamed.length).toBeGreaterThan(2);
    expect(streamed.map((step) => step.index)).toEqual(streamed.map((_, index) => index));
  });

  it('falls back to the last thing the model said when there is no answer', async () => {
    const ai = {
      run: async (_model: string, payload: unknown) => {
        const body = payload as { tools?: unknown[] };
        if (!body.tools) return { response: '' };
        return { response: 'Looking into it.', tool_calls: [{ name: 'web_search', arguments: { query: 'x' } }] };
      },
    } as unknown as Ai;

    const result = await runLoop({
      ai,
      system: 'system',
      task: 'go quiet at the end',
      tools: [toolThatAnswers('web_search', 'a result')],
      toolContext: context,
      usage,
      maxSteps: 1,
    });

    expect(result.ok).toBe(false);
    expect(result.answer).toBe('Looking into it.');
  });
});

describe('what a research run keeps', () => {
  it('keeps one entry per page, ignoring the query string', () => {
    const sources = dedupeSources([
      { url: 'https://x.test/about' },
      { url: 'https://x.test/about?utm_source=agent' },
      { url: 'https://x.test/contact' },
      { url: '' },
    ]);

    expect(sources.map((source) => source.url)).toEqual(['https://x.test/about', 'https://x.test/contact']);
  });

  it('summarises an answer to its first sentences, without the markdown', () => {
    const summary = firstSentences('## Heading\n\nThey roast on Tuesdays. They close Mondays. And more.', 2);
    expect(summary).toBe('Heading They roast on Tuesdays. They close Mondays.');
  });
});
