import type { Goal } from './goals.js';
import type { Model, ModelTurn } from './model.js';
import { openSession, type CellResult } from './session.js';

/**
 * The only SDK guidance the agent receives. Like the AppWorld study, it names
 * the two discovery entry points and nothing else: no operations, options,
 * object names or examples.
 */
export const systemPrompt = `You work in a persistent TypeScript REPL. Top-level await works and declarations persist between cells. Only console.log output is returned to you.

The variable \`relate\` is an authenticated client for a business data graph. You have no other documentation. Learn what data exists and how to read it from \`relate.describe()\` and \`relate.objects[apiName].describe()\`, and by inspecting results.

Run one cell at a time with the execute_code tool and read its output before the next cell. When you have the final answer, call \`submit(answer)\` in a cell, with the value in the requested shape. Compute answers from the data; do not guess.`;

export interface Step {
  readonly code: string;
  readonly result: CellResult;
  readonly model: Omit<ModelTurn, 'items' | 'code' | 'callId'>;
}

export interface Episode {
  readonly goal: string;
  readonly model: string;
  readonly sdk: string;
  readonly repeat: number;
  readonly success: boolean;
  /** Succeeded without a failed cell or a rejected SDK call. */
  readonly clean: boolean;
  readonly termination:
    'submitted' | 'turn-budget' | 'model-no-action' | 'timeout';
  readonly turns: number;
  readonly failedCells: number;
  readonly sdkErrors: readonly string[];
  /** Distinct SDK operations called, e.g. `objects.Ticket.traverse.agents`. */
  readonly operations: readonly string[];
  readonly answer?: unknown;
  readonly prelude?: CellResult;
  readonly steps: readonly Step[];
  readonly usage: { input: number; cached: number; output: number };
  readonly usd: number;
  readonly seconds: number;
}

export async function runEpisode(options: {
  goal: Goal;
  model: Model;
  checkout: string;
  sdk: string;
  repeat: number;
  maxTurns: number;
}): Promise<Episode> {
  const { goal, model } = options;
  const started = performance.now();
  const session = await openSession({
    checkout: options.checkout,
    goal: goal.id,
  });
  const steps: Step[] = [];
  let termination: Episode['termination'] = 'turn-budget';
  let answer: { value: unknown } | undefined;
  let prelude: CellResult | undefined;

  try {
    let task = goal.prompt;

    if (goal.prelude) {
      prelude = await session.execute(goal.prelude);
      task += `\n\n\`\`\`ts\n${goal.prelude}\n\`\`\`\n\nOutput:\n\n\`\`\`\n${prelude.output.trim()}\n\`\`\``;
    }

    const input: unknown[] = [
      { role: 'developer', content: systemPrompt },
      { role: 'user', content: task },
    ];

    for (let turn = 0; turn < options.maxTurns; turn++) {
      const { items, code, callId, ...usage } = await model.next(input);

      if (code === undefined || callId === undefined) {
        termination = 'model-no-action';
        break;
      }

      const result = await session.execute(code);

      steps.push({ code, result, model: usage });
      input.push(...items, {
        type: 'function_call_output',
        call_id: callId,
        output: result.output.trim() || '(no output)',
      });

      if (result.timedOut) {
        termination = 'timeout';
        break;
      }

      if (result.submitted) {
        answer = result.submitted;
        termination = 'submitted';
        break;
      }
    }
  } finally {
    await session.close();
  }

  const calls = steps.flatMap((step) => step.result.calls);
  const sdkErrors = calls.flatMap((call) =>
    call.error ? [`${call.path}: ${call.error}`] : [],
  );
  const failedCells = steps.filter((step) => step.result.error).length;
  const success =
    answer !== undefined && goal.score(answer.value, session.truth);
  const sum = (pick: (step: Step) => number) =>
    steps.reduce((total, step) => total + pick(step), 0);

  return {
    goal: goal.id,
    model: model.name,
    sdk: options.sdk,
    repeat: options.repeat,
    success,
    clean: success && failedCells === 0 && sdkErrors.length === 0,
    termination,
    turns: steps.length,
    failedCells,
    sdkErrors,
    operations: [...new Set(calls.map((call) => call.path))],
    ...(answer ? { answer: answer.value } : {}),
    ...(prelude ? { prelude } : {}),
    steps,
    usage: {
      input: sum((s) => s.model.usage.input),
      cached: sum((s) => s.model.usage.cached),
      output: sum((s) => s.model.usage.output),
    },
    usd: sum((s) => s.model.usd),
    seconds: (performance.now() - started) / 1000,
  };
}
