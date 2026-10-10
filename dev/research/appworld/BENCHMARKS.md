# Benchmark choice

Reviewed 2026-10-08. These are fit assessments for Relate, not claims that the
unmodified benchmarks evaluate graphs or that all were run here.

| Benchmark                                                           | What it exercises                                                                                 | Fit for a Relate comparison                                                                 | Main qualification                                                                                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| [AppWorld](https://github.com/StonyBrookNLP/appworld)               | Stateful simulated applications, API discovery, Python execution and programmatic task evaluation | Best first integration: preserve the task/evaluator and vary the data interface across apps | Prebuilt graph adapters and authenticated starts change the benchmark protocol; report an interface experiment                    |
| [τ-bench / τ²-bench](https://github.com/sierra-research/tau2-bench) | Customer-service policies, tools, user interaction and application actions                        | Strong next choice for graph reads followed by policy-constrained actions                   | Requires a user simulator as well as the tested agent; pin its model and benchmark version, and separate simulator failures       |
| [InsightBench](https://github.com/ServiceNow/insight-bench)         | Multi-step business analysis and insight generation over datasets                                 | Close to the motivating paper; useful for semantic descriptions, joins and analysis         | Insight scoring includes model-based judges; local-only judging adds another capability/variance question                         |
| [BIRD](https://bird-bench.github.io/)                               | Database-grounded text-to-SQL and execution accuracy                                              | Useful for schema understanding and relationship selection with objective query outcomes    | SQL already exposes joins; a graph adapter may measure schema translation more than operational application access                |
| [WebArena](https://github.com/web-arena-x/webarena)                 | Browser tasks in self-hosted web applications                                                     | Useful later for comparing graph-assisted work against browser-only work                    | Browser perception/navigation and environment setup add confounders; introducing graph access changes the interface substantially |

AppWorld was selected because it gives us actual application state and an
existing evaluator without needing another local model as a judge or simulated
user. Only AppWorld was executed in this PR. The other rows are research
options, not verified local installations.

## Relationship to EvoOntology

[EvoOntology](https://arxiv.org/abs/2609.15779) makes the ontology an
interactive runtime surface and refines it through paired evaluation. For
Relate, the useful starting experiment is to separate static descriptions, bulk
acquisition and executable relationships before attempting automatic ontology
changes.

This study uses a fixed, hand-authored model. It does not reproduce the paper's
builder, evolution loop, MCP transport or benchmark scores. A later evolution
experiment should freeze a baseline, propose one typed change at a time, retain
both successful and rejected proposals, and evaluate on tasks that were not used
to select the changes. Improvements on our two exploratory training cases would
not justify accepting an ontology mutation as generally better.
