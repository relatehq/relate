import { z } from 'zod';
import {
  defineAccess,
  defineAction,
  defineGraph,
  defineObject,
  implementAction,
  native,
  nativeMembership,
  objectId,
} from 'relate';
import { compile } from 'relate/compiler';
import { createRuntime } from '@relate/node';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import {
  connectStdio,
  createDevelopmentExecutor,
  createStreamableHttpHandler,
} from '@relate/mcp';

// A small native graph, using the runtime's default in-memory store.
const access = defineAccess({
  roles: ['editor'],
  claims: {},
  fieldGroups: ['ordinary'],
});
const Note = defineObject({
  id: 'demo.note',
  description: 'Notes written by the team.',
  membership: nativeMembership(),
  properties: {
    id: objectId({ id: 'note.id' }),
    text: native(z.string(), { id: 'note.text' }),
  },
});
const AddNote = defineAction({
  id: 'demo.add-note',
  description: 'Write a team note.',
  input: z.object({ text: z.string() }),
  output: z.object({ id: z.string() }),
  creates: [Note],
  policy: { execute: access.role('editor') },
});
const graph = defineGraph({
  id: 'mcp-demo',
  objects: { Note },
  actions: { addNote: AddNote },
  access,
  policies: {
    Note: {
      read: { gate: access.role('editor') },
      create: { gate: access.role('editor') },
    },
  },
});
const runtime = createRuntime({
  graph,
  connections: [],
  actionImplementations: [
    implementAction(graph, AddNote, async ({ input, objects }) => {
      const note = await objects.Note.create({ text: input.text });

      return { id: note.id };
    }),
  ],
});
// This local demo host chooses the actor. Real hosts authenticate the caller.
const actor = { id: 'demo-editor', roles: ['editor'], claims: {} };
const binding = {
  description: compile(graph).consumer,
  operations: runtime.operations(actor, { transport: 'mcp' }),
};
const executor = createDevelopmentExecutor();

await runtime
  .as(actor)
  .actions.addNote({ input: { text: 'Welcome' }, idempotencyKey: 'welcome' });

if (process.argv.includes('--stdio')) {
  const server = await connectStdio({ executor, bindGraph: () => binding });

  process.stdin.on('end', () => {
    void server.close().then(() => runtime.close());
  });
} else {
  // An MCP client talking Streamable HTTP through Fetch, without opening a port.
  // Mount this same handler at /mcp in your HTTP framework.
  const handle = createStreamableHttpHandler({
    executor,
    bindGraph: (request) =>
      request.headers.get('authorization') === 'Bearer local-demo'
        ? binding
        : new Response('Unauthorized', { status: 401 }),
  });
  const client = new Client({ name: 'relate-demo', version: '1' });

  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        requestInit: { headers: { authorization: 'Bearer local-demo' } },
        fetch: (input, init) => handle(new Request(input, init)),
      }),
    );

    for (const request of [
      { name: 'discover', arguments: {} },
      {
        name: 'execute',
        arguments: {
          code: 'return await graph.objects.Note.query({ limit: 10 });',
        },
      },
      {
        name: 'execute',
        arguments: {
          code: 'return await graph.actions.addNote({ input: { text: "Read the first note; adding a follow-up." }, idempotencyKey: "follow-up" });',
        },
      },
    ]) {
      const result = await client.callTool(request);

      if (result.isError) throw new Error(JSON.stringify(result));

      console.log(
        request.name,
        JSON.stringify(result.structuredContent, null, 2),
      );
    }
  } finally {
    await client.close();
    await runtime.close();
  }
}
