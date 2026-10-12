# Discovery-only probe

Can a model that has never seen Relate learn the read operations from the SDK
itself? The AppWorld study (#14) found that agents discovered objects and fields
but guessed call shapes: `traverse(id, 'songs')`, `{ pageSize, pageIndex }`. #18
added operation contracts to `describe()` and named request errors. This probe
measures whether that is enough, before more AppWorld task cases run.

## What the agent gets

A persistent TypeScript REPL with one variable, `relate` (an authenticated
consumer), and `submit(answer)`. The system prompt (`episode.ts`) names only
`relate.describe()` and `relate.objects[apiName].describe()`, the same two entry
points as the AppWorld study. It names no operations, options, object names or
examples. Goal prompts state a business question and the answer shape.

The graph is a probe-owned support desk (`desk.ts`), unrelated to AppWorld and
the examples: 8 accounts, 64 tickets, 6 agents, and assignments linking tickets
to agents. Every episode starts a fresh in-memory runtime with all rows adopted.

## Goals

| Goal                  | Question                                                      | Exercises                                 |
| --------------------- | ------------------------------------------------------------- | ----------------------------------------- |
| `count-all`           | How many tickets in total?                                    | Paging past the default page              |
| `filter-by-reference` | Open tickets for the account named "Northwind Traders"        | Equality filter with a Relate object ID   |
| `traverse-many`       | Subjects of every ticket raised by "Contoso"                  | To-many traversal (or a reference filter) |
| `traverse-one`        | Which account raised "Printer jams on tray 2"?                | To-one traversal (or a get by reference)  |
| `traverse-through`    | Agents assigned to "VPN drops every hour"                     | Many-to-many traversal through a junction |
| `continue-page`       | IDs of the second batch of ten, in client order               | Continuation cursor                       |
| `recover-from-error`  | Five ticket subjects, after a shown `{ pageSize: 5 }` failure | Reading a request error                   |

Answers are scored against source rows or, for `continue-page`, the SDK's own
second page. Every goal has a reference solution (`goals.ts`) that the tests run
through the real REPL.

## Measures

Per episode (`episode.ts`): `success` (scored answer submitted), `clean`
(success with no failed cell or rejected SDK call), turns, failed cells, SDK
errors, and the distinct SDK operations called, recorded by wrapping the
consumer. `summarize.ts` reports per-goal success, clean rate, traversal use,
mean turns and SDK errors, and estimated model cost.

The primary comparison is the same model and goals against two SDK builds:
`3836c0b` (main before #18) and current main. `--checkout` selects the build.

## Isolation

Each episode runs in a child Node process with an environment of `PATH` only,
under `--permission` with read access to the probe, dependencies and the SDK
build. Credentials are read by the host from a dotenv file and sent only to the
OpenAI API. The REPL context hides `process` and `require`, but is not itself a
boundary; a test escapes it deliberately and confirms that the child has no
secret to find and cannot read files outside its allow list.

## Run

```sh
pnpm build
# Baseline SDK, checked out and built separately:
pnpm worktree:create test/probe-baseline --base 3836c0b --skip-db
pnpm tsx dev/research/discovery-probe/run.ts --run mini-before \
  --checkout ../relate-worktrees/probe-baseline --sdk before \
  --credentials /path/to/credentials.env
pnpm tsx dev/research/discovery-probe/run.ts --run mini-after \
  --sdk after --credentials /path/to/credentials.env
```

Defaults: `gpt-5.4-mini`, low reasoning, 5 repeats per goal, 8 turns per
episode, a 4,096-token response cap and a $2 estimated-cost cap per run.
Transcripts, configs and summaries go to the ignored `.local/runs/<run>/`.

## Limits

Seven goals on one small graph, with prompts written by the SDK authors. A pass
shows the operations are learnable from discovery for these shapes, not general
agent accuracy. The REPL transpiles TypeScript without typechecking.
