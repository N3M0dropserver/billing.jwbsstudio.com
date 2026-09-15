/**
 * The loop.
 *
 * Ask the model. If it calls a tool, run the tool, show it what came back,
 * ask again. Stop when it answers, when the budget runs out, or when it
 * starts going in circles. That is the whole algorithm, and the interesting
 * parts are the three places it refuses to keep going:
 *
 *   A budget. Every run has a hard ceiling on tool calls. An agent that can
 *   browse can browse for ever, and an unattended one with a credit card
 *   attached will. When the budget is spent the model gets one more turn with
 *   no tools and an instruction to answer from what it has — a partial answer
 *   with its working shown beats silence.
 *
 *   A repetition guard. Models that lose their thread re-issue the same call
 *   with the same arguments. The second identical call gets a reply saying so
 *   rather than a second round trip, which is usually enough to break the
 *   pattern and always cheaper than not.
 *
 *   A tool cap per turn. A turn that asks for eight things at once is a turn
 *   that has not thought about the first one; only the first few are run.
 *
 * Every step is handed to `onStep` as it happens rather than returned at the
 * end, because the run page is watching and a research task that shows its
 * work while working is the difference between "it is thinking" and "it has
 * hung".
 */

import { trackedChat, type AiUsageContext } from '../ai/usage';
import type { ChatMessage, ToolCall } from '../ai/chat';
import { runTool, type ToolContext, type ToolDefinition } from './tools';

export interface LoopStep {
  index: number;
  kind: 'thought' | 'tool' | 'observation' | 'answer' | 'error';
  tool: string;
  input: Record<string, unknown>;
  output: string;
  ok: boolean;
  durationMs: number;
}

export interface LoopResult {
  ok: boolean;
  answer: string;
  steps: LoopStep[];
  /** Tool calls actually made. Not the same as steps. */
  toolCalls: number;
  error: string;
}

export interface LoopOptions {
  ai: Ai;
  /** The standing instructions: who the agent is and what it is doing. */
  system: string;
  /** The task itself. */
  task: string;
  tools: ToolDefinition[];
  toolContext: ToolContext;
  usage: AiUsageContext;
  maxSteps?: number;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  onStep?: (step: LoopStep) => Promise<void> | void;
}

/** Tool calls honoured from a single turn. */
export const MAX_CALLS_PER_TURN = 3;

/** How much of a tool's answer goes back into the conversation. */
export const MAX_OBSERVATION_CHARS = 6000;

export async function runLoop(options: LoopOptions): Promise<LoopResult> {
  const maxSteps = Math.min(Math.max(options.maxSteps ?? 8, 1), 24);
  const steps: LoopStep[] = [];
  const seen = new Set<string>();

  const messages: ChatMessage[] = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.task },
  ];

  let toolCalls = 0;
  let stepIndex = 0;

  const emit = async (step: LoopStep): Promise<void> => {
    steps.push(step);
    if (options.onStep) await options.onStep(step);
  };

  while (toolCalls < maxSteps) {
    const turn = await trackedChat(
      options.ai,
      {
        messages,
        tools: options.tools.map((tool) => tool.spec),
        model: options.model,
        temperature: options.temperature ?? 0.3,
        maxTokens: options.maxTokens ?? 1200,
      },
      options.usage,
    );

    if (!turn.ok) {
      await emit({
        index: stepIndex++,
        kind: 'error',
        tool: '',
        input: {},
        output: turn.error,
        ok: false,
        durationMs: 0,
      });

      // One failed turn is not a failed task if there is anything to say.
      return finish(steps, '', turn.error, toolCalls);
    }

    const { text, toolCalls: calls } = turn.data;

    if (text) {
      await emit({
        index: stepIndex++,
        kind: calls.length ? 'thought' : 'answer',
        tool: '',
        input: {},
        output: text,
        ok: true,
        durationMs: 0,
      });
    }

    if (calls.length === 0) {
      return finish(steps, text, '', toolCalls);
    }

    // Keep the model's own record of what it asked for, so a provider that
    // matches calls to results by id can do so.
    messages.push({
      role: 'assistant',
      content: text,
      tool_calls: turn.data.raw && typeof turn.data.raw === 'object'
        ? (turn.data.raw as Record<string, unknown>).tool_calls
        : undefined,
    });

    for (const call of calls.slice(0, MAX_CALLS_PER_TURN)) {
      if (toolCalls >= maxSteps) break;
      toolCalls++;

      const signature = `${call.name}:${JSON.stringify(call.arguments)}`;
      if (seen.has(signature)) {
        const note = `You already called ${call.name} with exactly these arguments and have the result above. Use it, try something different, or answer.`;
        messages.push({ role: 'tool', name: call.name, tool_call_id: call.id, content: note });
        await emit({
          index: stepIndex++,
          kind: 'observation',
          tool: call.name,
          input: call.arguments,
          output: note,
          ok: false,
          durationMs: 0,
        });
        continue;
      }
      seen.add(signature);

      await emit({
        index: stepIndex++,
        kind: 'tool',
        tool: call.name,
        input: call.arguments,
        output: '',
        ok: true,
        durationMs: 0,
      });

      const started = Date.now();
      const outcome = await runTool(options.toolContext, options.tools, call.name, call.arguments);
      const durationMs = Date.now() - started;

      const observation = outcome.output.slice(0, MAX_OBSERVATION_CHARS);
      messages.push({
        role: 'tool',
        name: call.name,
        tool_call_id: call.id,
        content: observation,
      });

      await emit({
        index: stepIndex++,
        kind: 'observation',
        tool: call.name,
        input: outcome.detail ?? {},
        output: observation,
        ok: outcome.ok,
        durationMs,
      });
    }

    const remaining = maxSteps - toolCalls;
    if (remaining <= 0) break;
    if (remaining <= 2) {
      messages.push({
        role: 'user',
        content: `You have ${remaining} tool call${remaining === 1 ? '' : 's'} left. Start drawing your answer together.`,
      });
    }
  }

  // Budget spent. One more turn, no tools, answer from what is known.
  const closing = await trackedChat(
    options.ai,
    {
      messages: [
        ...messages,
        {
          role: 'user',
          content:
            'You have used your tool budget. Answer now from what you have found. Be explicit about what you could not establish rather than filling the gap.',
        },
      ],
      model: options.model,
      temperature: options.temperature ?? 0.3,
      maxTokens: options.maxTokens ?? 1200,
    },
    options.usage,
  );

  if (closing.ok && closing.data.text) {
    await emit({
      index: stepIndex++,
      kind: 'answer',
      tool: '',
      input: {},
      output: closing.data.text,
      ok: true,
      durationMs: 0,
    });
    return finish(steps, closing.data.text, '', toolCalls);
  }

  return finish(
    steps,
    '',
    closing.ok ? 'The model ran out of tool calls without answering.' : closing.error,
    toolCalls,
  );
}

/**
 * Assemble the result.
 *
 * When there is no final answer, the last thing the model said stands in for
 * one. It is not the answer it was asked for, but it is what the run
 * produced, and a research page showing partial thinking is more use than one
 * showing an error.
 */
function finish(steps: LoopStep[], answer: string, error: string, toolCalls: number): LoopResult {
  const fallback = [...steps].reverse().find((step) => step.kind === 'thought' && step.output);

  return {
    ok: Boolean(answer) && !error,
    answer: answer || fallback?.output || '',
    steps,
    toolCalls,
    error,
  };
}
