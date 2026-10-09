import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { runEpisode, type Episode } from './episode.js';
import { goals } from './goals.js';
import { openAiModel } from './model.js';
import { repositoryRoot } from './session.js';
import { summarize } from './summarize.js';

const usage = `Usage: pnpm tsx dev/research/discovery-probe/run.ts --run <name> --credentials <file> [options]

  --checkout <path>     Relate checkout whose built SDK is probed (default: this one)
  --sdk <label>         Label for that SDK in results (default: current)
  --model <id>          gpt-5.4-mini (default) or gpt-5.4-nano
  --reasoning <effort>  none | low (default) | medium
  --repeats <n>         Episodes per goal (default 5)
  --goals <ids>         Comma-separated goal IDs (default: all)
  --max-turns <n>       Cells per episode (default 8)
  --max-cost-usd <n>    Stop starting episodes past this estimate (default 2)

The credentials file is a host-only dotenv file; only OPENAI_API_KEY is read.`;

const { values } = parseArgs({
  options: {
    run: { type: 'string' },
    credentials: { type: 'string' },
    checkout: { type: 'string', default: repositoryRoot },
    sdk: { type: 'string', default: 'current' },
    model: { type: 'string', default: 'gpt-5.4-mini' },
    reasoning: { type: 'string', default: 'low' },
    repeats: { type: 'string', default: '5' },
    goals: { type: 'string' },
    'max-turns': { type: 'string', default: '8' },
    'max-cost-usd': { type: 'string', default: '2' },
    'max-output-tokens': { type: 'string', default: '4096' },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || !values.run || !values.credentials) {
  console.log(usage);
  process.exit(values.help ? 0 : 1);
}

const apiKey = readFileSync(values.credentials, 'utf8')
  .split('\n')
  .map((line) => /^\s*OPENAI_API_KEY\s*=\s*"?([^"\s]+)"?\s*$/.exec(line)?.[1])
  .find(Boolean);

if (!apiKey) throw new Error('No OPENAI_API_KEY in the credentials file');

const selected = values.goals
  ? goals.filter((goal) => values.goals!.split(',').includes(goal.id))
  : goals;
const model = openAiModel({
  apiKey,
  model: values.model,
  reasoning: values.reasoning as 'none' | 'low' | 'medium',
  maxOutputTokens: Number(values['max-output-tokens']),
});
const out = join(import.meta.dirname, '.local/runs', values.run);
const cap = Number(values['max-cost-usd']);
const config = {
  run: values.run,
  checkout: resolve(values.checkout),
  sdk: values.sdk,
  model: values.model,
  reasoning: values.reasoning,
  repeats: Number(values.repeats),
  goals: selected.map((goal) => goal.id),
  maxTurns: Number(values['max-turns']),
  maxCostUsd: cap,
};

mkdirSync(out, { recursive: false });
writeFileSync(join(out, 'config.json'), JSON.stringify(config, null, 2));

const episodes: Episode[] = [];
let spent = 0;

// Interleave goals within each repeat so a budget stop leaves balanced coverage.
run: for (let repeat = 0; repeat < config.repeats; repeat++)
  for (const goal of selected) {
    if (spent >= cap) {
      console.log(`Stopped at the $${cap} estimate cap.`);
      break run;
    }

    const episode = await runEpisode({
      goal,
      model,
      checkout: config.checkout,
      sdk: config.sdk,
      repeat,
      maxTurns: config.maxTurns,
    });

    spent += episode.usd;
    episodes.push(episode);
    writeFileSync(
      join(out, `${goal.id}__${repeat}.json`),
      JSON.stringify(episode, null, 2),
    );
    console.log(
      `${goal.id} #${repeat}: ${episode.success ? 'pass' : 'fail'} (${episode.termination}, ${episode.turns} turns, $${episode.usd.toFixed(4)})`,
    );
  }

const summary = summarize(episodes);

writeFileSync(join(out, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n${summary.table}\nEstimated model cost: $${spent.toFixed(4)}`);
