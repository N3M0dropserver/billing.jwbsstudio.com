/**
 * Jev: typed decisions instead of parsed prose.
 *
 * Every classification in the growth pipeline has been a text model asked to
 * return JSON and hoped over. `qualifyProspect` asks a 70B model for a
 * fit score, an objective, and two booleans, then reads them back out of
 * `Record<string, unknown>` with `Number()`, `String()` and a cast — and the
 * cast is a lie, because nothing checked that `findings.objective` is one of
 * the three literals the type claims. When the JSON truncates or the model
 * answers in prose, the failure is silent and the defaults win.
 *
 * Jev is a "System One" model: it does not generate text at all. It takes a
 * shared `state` and a map of named, *typed* questions, and returns an answer
 * per question — a probability, a choice out of a closed set, or a position on
 * a scale. So the shape of the answer is decided by us, before the call, and
 * there is nothing to parse loosely.
 *
 * What this module adds on top is the type inference. `askJev` derives the
 * answer type from the question map, so:
 *
 *     const answers = await askJev(ai, state, {
 *       objective: choice('What does this site need to do?', {
 *         conversion: '…', awareness: '…', credibility: '…',
 *       }),
 *       tooBig: bool('Is this business beyond a freelancer?'),
 *       fit: score('How well would a cold concept land?', ['badly', 'fine', 'well']),
 *     }, usage);
 *
 * gives `answers.data.objective.choice` the type
 * `'conversion' | 'awareness' | 'credibility'` — not `string`, and not
 * `unknown`. A branch on it is exhaustively checkable, and adding an option to
 * the criteria is a compile error everywhere the old set was handled.
 *
 * Three things this deliberately does NOT do:
 *
 *   - It does not trust the response. A model's output is still a model's
 *     output: every answer is validated against the question that asked for
 *     it, and a choice outside the criteria or a score outside the scale
 *     fails the call rather than being coerced into the type.
 *   - It does not return a partial result. The inferred type says every key is
 *     present, so a call where one answer did not validate fails whole and the
 *     caller falls back. A type that is only sometimes true is worse than no
 *     type.
 *   - It does not ask Jev for anything it cannot do. It writes no text, so
 *     every sentence a prospect reads still comes from the text model. This
 *     replaces the *decisions*, not the prose.
 */

import type { AiResult } from './index';
import { requestHash, type AiUsageContext } from './usage';
import { aiCalls } from '../db/schema';
import { newId } from '../id';

/**
 * The model id, as Workers AI names it.
 *
 * No `@cf/` prefix: this is a partner model rather than one of Cloudflare's
 * own, and the prefix would make it a 404.
 */
export const JEV_MODEL = 'typesafe/jev';

/**
 * What a yes/no question is called on the wire.
 *
 * Kept as a constant because the two surfaces that serve this model do not
 * agree on the spelling: TypeSafe's own API and the Workers AI binding call it
 * `noul`, and the Vercel AI Gateway spells the same question type `boolean`.
 * The ANSWER comes back typed `boolean` either way, and `validateAnswer`
 * keys off the question rather than the reply's own label, so only the
 * request side is affected. If a request is ever rejected for an unknown
 * question type, this line is the whole fix.
 */
export const BOOL_QUESTION_TYPE = 'noul';

/* ------------------------------------------------------------------ */
/* Questions                                                          */
/* ------------------------------------------------------------------ */

/**
 * Instructions and criteria may each be a string, an object or an array.
 *
 * Narrowed to what this app actually sends. Passing an object where a
 * sentence would do is usually the better call — it is read as an extension of
 * the instruction, and structure is harder to misread than a paragraph.
 */
export type Wording = string | Record<string, unknown> | unknown[];

export interface BoolQuestion {
  type: typeof BOOL_QUESTION_TYPE;
  instructions: Wording;
  /** Optional, and worth writing: it is what stops "urgent" meaning two things. */
  criteria?: { true: Wording; false: Wording };
}

export interface ChoiceQuestion<Option extends string> {
  type: 'choice';
  instructions: Wording;
  /** Required. Every option, each with the description that defines it. */
  criteria: Record<Option, Wording>;
}

export interface ScoreQuestion<Levels extends readonly string[]> {
  type: 'score';
  instructions: Wording;
  /** Required. Two or more levels, lowest first. */
  criteria: Levels;
}

export type AnyQuestion =
  | BoolQuestion
  | ChoiceQuestion<string>
  | ScoreQuestion<readonly string[]>;

/**
 * A yes/no question.
 *
 * Read the answer with `yes`. Note that Jev's boolean probability is
 * documented as UNCALIBRATED — unlike a choice or a score, the number is a
 * direction rather than a frequency, so 0.9 does not mean nine times out of
 * ten. Anything where the threshold itself carries weight should be a
 * `choice` or a `score`, which do come with calibrated confidence.
 */
export function bool(instructions: Wording, criteria?: { true: Wording; false: Wording }): BoolQuestion {
  return criteria
    ? { type: BOOL_QUESTION_TYPE, instructions, criteria }
    : { type: BOOL_QUESTION_TYPE, instructions };
}

/**
 * One of a closed set.
 *
 * `const` on the parameter is what makes the call site's keys survive into the
 * answer type instead of widening to `string`.
 */
export function choice<const Option extends string>(
  instructions: Wording,
  criteria: Record<Option, Wording>,
): ChoiceQuestion<Option> {
  return { type: 'choice', instructions, criteria };
}

/**
 * A position on a scale, lowest level first.
 *
 * The tuple type requires at least two levels, because a one-level scale has
 * no position to return and the model rejects it.
 */
export function score<const Levels extends readonly [string, string, ...string[]]>(
  instructions: Wording,
  criteria: Levels,
): ScoreQuestion<Levels> {
  return { type: 'score', instructions, criteria };
}

/* ------------------------------------------------------------------ */
/* Answers                                                            */
/* ------------------------------------------------------------------ */

export interface BoolAnswer {
  type: 'boolean';
  /** P(true). Uncalibrated — see `bool`. */
  probability: number;
}

export interface ChoiceAnswer<Option extends string> {
  type: 'choice';
  /** The highest-probability option. Always one of the criteria keys. */
  choice: Option;
  /** Every option, including the ones the response omitted, which read 0. */
  probabilities: Record<Option, number>;
  confidence: number;
  confidenceSource: ConfidenceSource;
}

export interface ScoreAnswer<Level extends string = string> {
  /** A fractional position in `[0, levels - 1]`: a weighted mean, not an index. */
  score: number;
  type: 'score';
  probabilities: Record<string, number>;
  confidence: number;
  confidenceSource: ConfidenceSource;
  /** The same position as `0..1`, which is what most callers actually want. */
  fraction: number;
  /** The nearest level's label, for logging a decision in words. */
  level: Level;
}

/**
 * Where a confidence figure came from.
 *
 * `reported` is Jev's own calibrated number. `derived` is ours, computed from
 * the probability spread because the response did not carry one — it ranks
 * answers sensibly but it is NOT the calibrated quantity, so a threshold tuned
 * against one is not transferable to the other.
 */
export type ConfidenceSource = 'reported' | 'derived';

export type AnswerFor<Q> =
  Q extends ChoiceQuestion<infer Option>
    ? ChoiceAnswer<Option>
    : Q extends ScoreQuestion<infer Levels>
      ? ScoreAnswer<Levels[number] & string>
      : Q extends BoolQuestion
        ? BoolAnswer
        : never;

export type Answers<Questions> = { [K in keyof Questions]: AnswerFor<Questions[K]> };

/* ------------------------------------------------------------------ */
/* Reading an answer                                                  */
/* ------------------------------------------------------------------ */

/** A yes/no answer at a threshold. Defaults to the even split. */
export function yes(answer: BoolAnswer, threshold = 0.5): boolean {
  return answer.probability >= threshold;
}

/**
 * A choice, but only when the model was confident enough to act on.
 *
 * Returns null below the floor so a caller can fall back to a measured
 * default rather than take a coin-flip. This is the point of a calibrated
 * model: an unsure answer is usable information rather than a wrong one.
 */
export function pick<Option extends string>(
  answer: ChoiceAnswer<Option>,
  floor: number,
): Option | null {
  return answer.confidence >= floor ? answer.choice : null;
}

/** Map a score's position onto a numeric range — a 0..100 fit, say. */
export function scaleTo(answer: ScoreAnswer, min: number, max: number): number {
  return min + answer.fraction * (max - min);
}

/**
 * Confidence from the shape of a distribution: one minus its normalised
 * entropy.
 *
 * A distribution concentrated on one option scores near 1; a flat one scores
 * near 0. Used only when the response does not report a confidence of its
 * own, and labelled `derived` when it is.
 */
export function derivedConfidence(probabilities: number[]): number {
  const total = probabilities.reduce((sum, p) => sum + Math.max(0, p), 0);
  if (total <= 0 || probabilities.length < 2) return 0;

  const entropy = probabilities.reduce((sum, raw) => {
    const p = Math.max(0, raw) / total;
    return p > 0 ? sum - p * Math.log(p) : sum;
  }, 0);

  const normalised = entropy / Math.log(probabilities.length);
  return Math.min(1, Math.max(0, 1 - normalised));
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const finite = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

/** Read a `{ option: probability }` map, keeping only the keys we asked about. */
function readProbabilities(raw: unknown, keys: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const source = isRecord(raw) ? raw : {};

  for (const key of keys) {
    const value = finite(source[key]);
    out[key] = value === null ? 0 : Math.min(1, Math.max(0, value));
  }

  return out;
}

/**
 * The confidence for one answer.
 *
 * Checked in the answer itself first, then in the two places the surfaces are
 * documented to put it, and only then derived. Deliberately not hunted for
 * across the whole response: a number found by guesswork and labelled
 * `reported` would be worse than an honest `derived` one.
 */
function readConfidence(
  answer: Record<string, unknown>,
  meta: unknown,
  name: string,
  probabilities: number[],
): { confidence: number; confidenceSource: ConfidenceSource } {
  const direct = finite(answer.confidence);
  if (direct !== null) {
    return { confidence: Math.min(1, Math.max(0, direct)), confidenceSource: 'reported' };
  }

  // `providerMetadata.typesafe.confidence`, keyed by question name.
  const typesafe = isRecord(meta) && isRecord(meta.typesafe) ? meta.typesafe : null;
  const byName = typesafe && isRecord(typesafe.confidence) ? finite(typesafe.confidence[name]) : null;
  if (byName !== null) {
    return { confidence: Math.min(1, Math.max(0, byName)), confidenceSource: 'reported' };
  }

  return { confidence: derivedConfidence(probabilities), confidenceSource: 'derived' };
}

/** Why one answer could not be used. Returned rather than thrown. */
interface AnswerProblem {
  question: string;
  reason: string;
}

function validateAnswer(
  name: string,
  question: AnyQuestion,
  raw: unknown,
  meta: unknown,
): { ok: true; answer: unknown } | { ok: false; problem: AnswerProblem } {
  const fail = (reason: string) => ({ ok: false as const, problem: { question: name, reason } });

  if (!isRecord(raw)) return fail('the response carried no answer for it');

  if (question.type === 'choice') {
    const options = Object.keys(question.criteria);
    const probabilities = readProbabilities(raw.probabilities, options);
    const chosen = typeof raw.choice === 'string' ? raw.choice : '';

    // A choice outside the criteria is the one failure that must never be
    // coerced: the whole value of the type is that the set is closed.
    if (!options.includes(chosen)) {
      return fail(
        chosen
          ? `answered "${chosen.slice(0, 40)}", which is not one of ${options.join(', ')}`
          : 'answered with no choice at all',
      );
    }

    return {
      ok: true,
      answer: {
        type: 'choice',
        choice: chosen,
        probabilities,
        ...readConfidence(raw, meta, name, Object.values(probabilities)),
      } satisfies ChoiceAnswer<string>,
    };
  }

  if (question.type === 'score') {
    const levels = question.criteria;
    if (levels.length < 2) return fail('the scale has fewer than two levels');

    const value = finite(raw.score);
    if (value === null) return fail('answered with no score');

    const top = levels.length - 1;
    // Clamped rather than rejected: a score is a weighted mean, and one a
    // hair outside the scale is a rounding artefact rather than a wrong
    // answer. A choice outside its set is a different kind of wrong.
    const clamped = Math.min(top, Math.max(0, value));
    const probabilities = readProbabilities(
      raw.probabilities,
      levels.map((_, index) => String(index)),
    );

    return {
      ok: true,
      answer: {
        type: 'score',
        score: clamped,
        fraction: clamped / top,
        level: levels[Math.round(clamped)] ?? levels[top]!,
        probabilities,
        ...readConfidence(raw, meta, name, Object.values(probabilities)),
      } satisfies ScoreAnswer,
    };
  }

  const probability = finite(raw.probability);
  if (probability === null) return fail('answered with no probability');

  return {
    ok: true,
    answer: {
      type: 'boolean',
      probability: Math.min(1, Math.max(0, probability)),
    } satisfies BoolAnswer,
  };
}

/* ------------------------------------------------------------------ */
/* The call                                                           */
/* ------------------------------------------------------------------ */

/** State may be a string, an object or an array; structure beats prose. */
export type JevState = string | Record<string, unknown> | unknown[];

export interface JevOptions {
  /** Abandon the call after this long. */
  timeoutMs?: number;
}

/**
 * Jev's own guidance, worth restating because it is a real constraint on how
 * these question sets are written: each question is evaluated in parallel and
 * in isolation against the same state. So they cost almost nothing to add,
 * and none of them can depend on another's answer. Anything that needs two
 * factors weighed together is two questions and some code.
 */
export const MAX_QUESTIONS = 64;

/**
 * Ask a set of typed questions about one state.
 *
 * Never throws. A transport failure, a malformed response or a single answer
 * that does not validate all come back as `ok: false` with a reason a log line
 * can carry, and callers are expected to have a measured fallback — every
 * caller in this app does.
 */
export async function askJev<const Questions extends Record<string, AnyQuestion>>(
  ai: Ai,
  state: JevState,
  questions: Questions,
  ctx: AiUsageContext,
  options: JevOptions = {},
): Promise<AiResult<Answers<Questions>>> {
  const names = Object.keys(questions);

  if (names.length === 0) return { ok: false, error: 'No questions to ask.' };
  if (names.length > MAX_QUESTIONS) {
    return { ok: false, error: `Too many questions at once (${names.length}).` };
  }

  const started = Date.now();
  let failure = '';
  let response: unknown;

  try {
    response = await withTimeout(
      ai.run(JEV_MODEL as Parameters<Ai['run']>[0], { state, questions } as never),
      options.timeoutMs ?? 20_000,
    );
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  }

  const durationMs = Date.now() - started;

  const outcome: AiResult<Answers<Questions>> = failure
    ? { ok: false, error: failure.slice(0, 300) }
    : interpret(response, questions, names);

  await recordJevCall(ctx, {
    durationMs,
    ok: outcome.ok,
    error: outcome.ok ? '' : outcome.error,
    questions: names,
    response,
  });

  return outcome;
}

function interpret<Questions extends Record<string, AnyQuestion>>(
  response: unknown,
  questions: Questions,
  names: string[],
): AiResult<Answers<Questions>> {
  /**
   * The answers may be the response or may be nested under it.
   *
   * Only the shapes the surfaces are documented to return are accepted. A
   * broader search — "find an object that has my question names in it" —
   * would happily pick up an error payload that happened to echo them.
   */
  const body = isRecord(response)
    ? (isRecord(response.answers) ? response.answers : isRecord(response.result) ? response.result : response)
    : null;

  if (!body) return { ok: false, error: 'The model returned nothing we could read.' };

  const meta = isRecord(response) ? (response.providerMetadata ?? response.provider_metadata) : null;

  const answers: Record<string, unknown> = {};
  const problems: AnswerProblem[] = [];

  for (const name of names) {
    const result = validateAnswer(name, questions[name]!, body[name], meta);
    if (result.ok) answers[name] = result.answer;
    else problems.push(result.problem);
  }

  if (problems.length) {
    return {
      ok: false,
      error: problems.map((problem) => `${problem.question}: ${problem.reason}`).join('; ').slice(0, 300),
    };
  }

  return { ok: true, data: answers as Answers<Questions>, raw: response };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Jev timed out after ${ms}ms`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Book a Jev call on the usage ledger.
 *
 * Recorded like every other model call so a pipeline that asks forty typed
 * questions per prospect shows up on the AI usage page rather than as an
 * unexplained line on the bill. Tokens are left at zero and marked unmeasured:
 * Jev is not billed per generated token and inventing a count to fill the
 * column would make the token totals fiction.
 */
async function recordJevCall(
  ctx: AiUsageContext,
  row: {
    durationMs: number;
    ok: boolean;
    error: string;
    questions: string[];
    response: unknown;
  },
): Promise<void> {
  try {
    await ctx.db.insert(aiCalls).values({
      id: newId(),
      userId: ctx.userId,
      campaignId: ctx.campaignId ?? null,
      prospectId: ctx.prospectId ?? null,
      stage: ctx.stage ?? '',
      operation: ctx.operation,
      model: JEV_MODEL,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      tokensMeasured: false,
      /**
       * Left at zero rather than estimated.
       *
       * There is no published per-call rate for this model in
       * `MODEL_PRICING`, and a token-based guess for a model that does not
       * bill per token would be wrong by orders of magnitude rather than by a
       * rounding error. `costConfident: false` is what marks the gap on the
       * usage page; fill both in once the real rate is known.
       */
      costMicrocents: 0,
      costConfident: false,
      durationMs: row.durationMs,
      cached: false,
      ok: row.ok,
      error: row.error.slice(0, 500),
      requestHash: (
        await requestHash({
          system: JEV_MODEL,
          prompt: row.questions.join(','),
          model: JEV_MODEL,
        })
      ).slice(0, 16),
      createdAt: new Date().toISOString(),
    });
  } catch {
    // Observability must never be the thing that breaks the pipeline.
  }
}

/** True when the deployment has a Workers AI binding at all. */
export function jevAvailable(ai: Ai | null | undefined): ai is Ai {
  return !!ai && typeof ai.run === 'function';
}

/**
 * One line per decision, for a run log.
 *
 * A typed decision is only an improvement on a parsed one if you can see what
 * it was and how sure it was — otherwise it is the same black box with better
 * types.
 */
export function describeAnswers(answers: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [name, value] of Object.entries(answers)) {
    if (!isRecord(value)) continue;

    if (value.type === 'choice') {
      const answer = value as unknown as ChoiceAnswer<string>;
      lines.push(
        `${name}: ${answer.choice} (${Math.round(answer.confidence * 100)}%${
          answer.confidenceSource === 'derived' ? ' derived' : ''
        })`,
      );
    } else if (value.type === 'score') {
      const answer = value as unknown as ScoreAnswer;
      lines.push(
        `${name}: ${answer.level} (${answer.score.toFixed(2)}, ${Math.round(answer.confidence * 100)}%${
          answer.confidenceSource === 'derived' ? ' derived' : ''
        })`,
      );
    } else if (value.type === 'boolean') {
      const answer = value as unknown as BoolAnswer;
      lines.push(`${name}: ${yes(answer) ? 'yes' : 'no'} (p=${answer.probability.toFixed(2)})`);
    }
  }

  return lines.join('\n');
}
