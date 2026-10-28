/** Runs inside a networkless container. The host permits only domain tool RPC. */
import { createInterface } from 'node:readline';
import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  implementAction,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import { createDevelopmentExecutor, javascriptInstructions } from '@relate/mcp';

type Row = Record<string, unknown>;
type Tool = {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
};
const lines = createInterface({ input: process.stdin });
const pending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const send = (value: unknown) =>
  process.stdout.write(JSON.stringify(value) + '\n');
let sequence = 0;
const invoke = (name: string, args: unknown) =>
  new Promise<unknown>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    send({ type: 'invoke', id, name, arguments: args });
  });
const access = defineAccess({
  roles: ['agent'],
  fieldGroups: ['ordinary'],
  claims: {},
});
let runtime: ReturnType<typeof createRuntime> | undefined;
let binding:
  | Parameters<
      ReturnType<typeof createDevelopmentExecutor>['execute']
    >[0]['graph']
  | undefined;
const executor = createDevelopmentExecutor({
  timeoutMs: 60000,
  maxOutputBytes: 1048576,
});

async function command(message: Row) {
  if (message.type === 'init') {
    const tools = message.tools as Tool[];
    const actions = Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        defineAction({
          id: `benchmark.${tool.name}`,
          description: `${tool.description ?? tool.name}\narguments must be a JSON string matching this original tool schema: ${JSON.stringify(tool.parameters)}`,
          input: z.object({ arguments: z.string() }),
          output: z.object({ value: z.string() }),
          policy: { execute: access.role('agent') },
        }),
      ]),
    );
    const graph = defineGraph({
      id: 'external-benchmark',
      access,
      objects: {},
      actions,
      policies: {},
    });
    runtime = createRuntime({
      graph,
      bindings: [],
      actionImplementations: tools.map((tool) =>
        implementAction(graph, actions[tool.name]!, async ({ input }) => ({
          value: JSON.stringify(
            await invoke(tool.name, JSON.parse(input.arguments)),
          ),
        })),
      ),
    });
    binding = {
      description: compile(graph).consumer,
      operations: runtime.operations({
        id: 'agent',
        roles: ['agent'],
        claims: {},
      }),
    };
    return {
      ready: true,
      instructions:
        javascriptInstructions +
        '\nAction input.arguments is JSON.stringify(original tool arguments); its schema is in the action description. Action output.value is the original tool result encoded as JSON. Use JSON.parse(receipt.output.value).',
    };
  }
  if (!binding) throw new Error('Initialize before execution');
  if (message.type === 'discover')
    return {
      graph: binding.operations.discovery.describe(),
      instructions: javascriptInstructions,
    };
  if (message.type === 'execute')
    return executor.execute({ code: String(message.code), graph: binding });
  throw new Error('Unknown command');
}

// Resolve callback replies while the command awaits the original environment.
lines.on('line', (line) => {
  const message = JSON.parse(line) as Row;
  if (message.type === 'result') {
    const waiter = pending.get(Number(message.id));
    if (!waiter) throw new Error('Unexpected tool reply');
    pending.delete(Number(message.id));
    if (message.error) waiter.reject(new Error(String(message.error)));
    else waiter.resolve(message.value);
  } else {
    void command(message).then(
      (value) => send({ type: 'reply', value }),
      (error) => send({ type: 'reply', error: String(error) }),
    );
  }
});
lines.on('close', () => {
  void runtime?.close();
});
