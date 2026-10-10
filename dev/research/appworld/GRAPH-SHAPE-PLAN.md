# Explicit contact graph: frozen experiment plan

Run `sdk-nano-contact-graph-v1` compares the new local graph with
`sdk-nano-no-answer-v1`. Only the research graph and its acquisition-to-graph
mapping change. No package, system prompt, completion, REPL, action or evaluator
changes; no main refresh.

The model replaces Person.relationshipsJson with owner-scoped
ContactRelationship records (owner, contact, kind), exposes Person.email instead
of the generic sourceId property, adds navigable owner/contact relationships,
and supplies property descriptions. Provider identity still uses the exact email
internally. Labels are copied from the same phone-contact API responses;
transactions are unchanged. The supplied supervisor context, already visible to
all agents, anchors the owner and ensures that Person exists even without a
transaction. No extra API calls, inferred labels or task-dependent acquisition.
Timestamp values remain unchanged; descriptions explain their lack of offset.

Same three tasks: afc0fce_1, afc0fce_2, d0b1f43_1. Same three methods: raw
Python, raw TypeScript, Relate SDK. Same two repeats and rotating order: 18
fresh episodes. Same nano low reasoning, 28 turns, world seed 100, 4096
tokens/request, 14000 output tokens/episode, 14000 visible characters/turn,
60-second execution timeout, and $2 run cap. No per-turn feedback, retries or
changes after inspecting scores. Static notes remain retired.

Compare original task success, write-state/answer checks, read control, time,
turns, tokens and cost. Inspect whether agents actually discover and use the new
relationship records. Preserve every trajectory. Fresh stochastic runs and new
graph IDs are not matched conversation prefixes; the unchanged raw methods
provide a contemporaneous check on variability. This is a combined model-shape
and description intervention, not an isolated test of one field.

Pre-run validation: 18 Python tests, 11 Node tests, and original AppWorld
write/readback/idempotency smoke. All new work stays in dev/research/appworld.
