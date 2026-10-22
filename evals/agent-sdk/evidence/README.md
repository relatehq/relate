# Retained validation, 22 October 2026

This evidence validates the evaluation system against SDK commit
`72d2c3d28c29709d55e107ad5cde1807760682fb`. The source checkout had harness
changes; exact built SDK input hashes, source snapshots, model configuration and
image identity are retained per run. This is a small integration smoke, not a
model ranking or evidence of performance across the full catalog.

## Validation

| Check                                   | Result                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Repository `pnpm check`                 | 187 test files; 2,673 passed, 1 skipped; formatting, lint, types, boundaries and packaging passed |
| Standalone integration/regression suite | 22 passed; two third-party Inspect deprecation warnings                                           |
| Reference solutions                     | 84 / 84 passed, covering all 28 families and four levels                                          |
| Live provider smoke                     | 32 / 32 scored; no provider/environment errors in the final run                                   |
| Image retention regression              | Original image remained usable after rebuilding the moving development tag during the live run    |
| Inspect viewer                          | Opened in Chrome; sample scores and model/tool transcripts inspected                              |

The repository check preceded the final reporting and image-tag lifecycle fixes.
Focused lint, formatting, boundary and harness checks were rerun afterward. The
image retention fix was additionally checked during the final live run. This
local evidence uses macOS/Apple Silicon with Linux Docker containers; CI runs
the credential-free suite on Linux. CI outcomes are available on the PR.

## Final live smoke

Eight families, seed 11, two fresh trials each; the default `tool-agent` solver
and the same prompts and budgets for both configurations. The full 84-task model
matrix has **not** been run. Token totals include cache reads/writes; they are
usage counts, not cost estimates.

| Model                        | Passed / planned | Scored | Errors / missing | Input / output tokens |
| ---------------------------- | ---------------- | ------ | ---------------- | --------------------- |
| `openai/gpt-5.4-nano`        | 0 / 16           | 16     | 0 / 0            | 495,573 / 13,649      |
| `anthropic/claude-haiku-5-5` | 11 / 16          | 16     | 0 / 0            | 609,934 / 20,092      |

The scorer requires the requested typed JSON through `submit(value)`, the exact
resulting review state, and any explicitly requested procedure. Nano had nine
answer mismatches, six attempts without a submission, and one state mismatch.
Haiku had four attempts without a submission and one answer mismatch. These
categories use the grader's first failure reason; several trials fail multiple
components. Inspect the retained `outcome` and `code_cells` to distinguish
answer shape, incomplete work and incorrect state. The two alternative solver
paths were tested with Inspect's mock model, not compared in the paid model run.

[Machine-readable validation](validation.json) contains all retained attempt
summaries. [Final per-trial report](smoke-results.json) contains scores,
component outcomes, token breakdowns, time, SDK calls/errors, limits and
same-task reliability estimates. With two trials, estimates for `k=3` are
unavailable.

## Earlier attempts

Earlier attempts remain separate and are not pooled into the final result.

| Run                | Observed result                                     | Why incomplete / what changed                                                                          |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `live-smoke`       | 32 planned, no samples                              | Initial OpenAI dependency was too old; fixed and locked provider versions                              |
| `live-smoke-v2`    | Nano 1 / 16; Haiku 16 missing                       | Anthropic dependency failed at startup; fixed and locked provider version                              |
| `live-smoke-v3`    | Nano 1 / 16; Haiku 8 / 16 with 7 environment errors | Rebuilding the moving Docker tag reclaimed the in-flight image; fixed by retaining a dedicated run tag |
| `live-smoke-final` | Nano 0 / 16; Haiku 11 / 16; all scored              | Fresh complete run after the dependency/image fixes                                                    |

The earliest runner did not retain a structured setup error, so its reports mark
unstarted samples missing; it does not fabricate model failures. The current
runner retains `setup-errors.jsonl` and marks the affected planned trials as
errors. Reports for every run were regenerated with the reporting code included
in `checks/report.py`, correcting cache-token totals. Original Inspect logs and
run-time source snapshots were preserved unchanged.

## Inspect or reproduce

The [archive](validation-2026-10-22.tar.xz) contains five run directories, their
original `.eval` logs, source/bundle snapshots, manifests, task prompts, derived
reports, and validation logs. No provider keys or environment files are
included. Each archived file is covered by `SHA256.json`; the archive and
adjacent JSON files are covered by [SHA256SUMS](SHA256SUMS).

From `evals/agent-sdk`, after `uv sync --locked`, verify and unpack:

```sh
(cd evidence && shasum -a 256 -c SHA256SUMS)
mkdir -p .local/retained-validation
tar -xJf evidence/validation-2026-10-22.tar.xz -C .local/retained-validation
uv run relate-eval report .local/retained-validation/runs/live-smoke-final
uv run inspect view --recursive --log-dir .local/retained-validation/runs/live-smoke-final/logs
```

Re-run with the commands in the [suite README](../README.md). Use a new output
directory. A new model run is a new experiment: provider aliases,
runtime-generated receipts/cursors and stochastic outputs need not match these
trajectories. The original image ID is local-machine evidence; rebuild the
pinned Dockerfile and retained worker bundle when reproducing elsewhere.
