import { expect, test, vi } from 'vitest';
import {
  salesforce,
  SalesforceSourceError,
} from '@relate/connector-salesforce';
import { SourceAccessDenied } from 'relate/connectors';
import {
  accountId,
  credentials,
  fixture,
  orgId,
  queryResult,
  row,
  signal,
} from './fixture.js';

test('defers I/O and verifies identity with the same credentials for every read', async () => {
  let token = 'one';
  const resolve = vi.fn(() => ({ ...credentials, accessToken: token }));
  const f = fixture({ credentials: resolve });

  expect(f.calls).toHaveLength(0);
  expect(await f.resource.identify({ signal: signal() })).toBe(orgId);
  expect(await f.resource.fetch(accountId, { signal: signal() })).toEqual({
    state: 'present',
    providerAccountId: orgId,
    record: {
      Id: accountId,
      IsDeleted: false,
      Name: 'Northwind',
      Website: null,
    },
  });
  token = 'two';
  f.setOrg('00D000000000002EAA');
  expect(await f.resource.fetch(accountId, { signal: signal() })).toMatchObject(
    { providerAccountId: '00D000000000002EAA' },
  );
  expect(resolve).toHaveBeenCalledTimes(3);
  expect(
    f.calls.map((call) => new Headers(call.init?.headers).get('Authorization')),
  ).toEqual([
    'Bearer one',
    'Bearer one',
    'Bearer one',
    'Bearer two',
    'Bearer two',
  ]);
  expect(
    f.calls.every(
      (call) => call.init?.redirect === 'error' && call.init.method === 'GET',
    ),
  ).toBe(true);
  expect(new URL(f.calls[2]!.url).searchParams.get('q')).toBe(
    `SELECT Id,IsDeleted,Name,Website FROM Account WHERE Id = '${accountId}' LIMIT 1`,
  );
});

test('canonicalizes 15-character provider identity and preserves adopted source ID', async () => {
  const f = fixture();

  f.setOrg(orgId.slice(0, 15));
  expect(
    await f.resource.fetch(accountId.slice(0, 15), { signal: signal() }),
  ).toMatchObject({
    providerAccountId: orgId,
    record: { Id: accountId.slice(0, 15) },
  });
});

test('requires affirmative deletion and withholds records hidden by sharing', async () => {
  const f = fixture();

  f.respond(queryResult([{ ...row(), IsDeleted: true }]));
  expect(await f.resource.fetch(accountId, { signal: signal() })).toEqual({
    state: 'deleted',
    providerAccountId: orgId,
  });
  f.respond(queryResult([]));
  await expect(
    f.resource.fetch(accountId, { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
  f.respond([{ errorCode: 'NOT_FOUND' }], 404);
  await expect(
    f.resource.fetch(accountId, { signal: signal() }),
  ).rejects.toBeInstanceOf(SalesforceSourceError);
});

test.each([401, 403])(
  'HTTP %s on either endpoint is explicit denial',
  async (status) => {
    const f = fixture({
      fetch: async () => new Response('secret', { status }),
    });

    await expect(
      f.resource.identify({ signal: signal() }),
    ).rejects.toBeInstanceOf(SourceAccessDenied);
    const records = fixture();

    records.respond({}, status);
    await expect(
      records.resource.fetch(accountId, { signal: signal() }),
    ).rejects.toBeInstanceOf(SourceAccessDenied);
  },
);

test.each([
  'INVALID_SESSION_ID',
  'INSUFFICIENT_ACCESS',
  'INSUFFICIENT_ACCESS_OR_READONLY',
  'API_DISABLED_FOR_ORG',
  'INVALID_FIELD',
  'INVALID_TYPE',
])('maps Salesforce %s to denial', async (errorCode) => {
  const f = fixture();

  f.respond([{ errorCode, message: 'secret details' }], 400);
  await expect(
    f.resource.fetch(accountId, { signal: signal() }),
  ).rejects.toThrow(new SourceAccessDenied());
});

test.each([429, 500, 503])(
  'HTTP %s remains unavailability and diagnostics are sanitized',
  async (status) => {
    const f = fixture();

    f.respond(
      [{ errorCode: 'SERVER_UNAVAILABLE', message: credentials.accessToken }],
      status,
    );
    await expect(
      f.resource.fetch(accountId, { signal: signal() }),
    ).rejects.toThrow(new SalesforceSourceError(status));
  },
);

test.each([
  { done: false, totalSize: 1, records: [row()] },
  { done: true, totalSize: 2, records: [row()] },
  queryResult([{ ...row(), Id: '001000000000002AAA' }]),
  queryResult([{ ...row(), IsDeleted: 'false' }]),
  queryResult([{ ...row(), attributes: { type: 'Contact' } }]),
  queryResult([{ ...row(), Name: Number.MAX_SAFE_INTEGER + 1 }]),
])('rejects malformed query evidence %#', async (result) => {
  const f = fixture();

  f.respond(result);
  await expect(
    f.resource.fetch(accountId, { signal: signal() }),
  ).rejects.toBeInstanceOf(SalesforceSourceError);
});

test('missing selected fields cannot disclose previously cached values', async () => {
  const f = fixture();

  f.respond(
    queryResult([
      { Id: accountId, attributes: { type: 'Account' }, IsDeleted: false },
    ]),
  );
  await expect(
    f.resource.fetch(accountId, { signal: signal() }),
  ).rejects.toBeInstanceOf(SourceAccessDenied);
});

test.each([
  "001000000000001AAA' OR Name != ''",
  '001000000000001BBB',
  '../secrets',
])('rejects invalid source ID before I/O: %s', async (id) => {
  const f = fixture();

  await expect(
    f.resource.fetch(id, { signal: signal() }),
  ).rejects.toBeInstanceOf(SalesforceSourceError);
  expect(f.calls).toHaveLength(0);
});

test.each(['Name FROM User', 'Owner.Name', 'constructor', 'attributes'])(
  'rejects unsupported field expression: %s',
  (field) => {
    expect(() =>
      fixture().connection.resource('Account', { fields: [field] }),
    ).toThrow();
  },
);

test.each([
  'http://example.com',
  'https://user:password@example.com',
  'https://example.com/path',
  'https://example.com/?query=1',
])('rejects unsafe credential origin %s', async (instanceUrl) => {
  const f = fixture({ credentials: { ...credentials, instanceUrl } });

  await expect(
    f.resource.identify({ signal: signal() }),
  ).rejects.toBeInstanceOf(SalesforceSourceError);
  expect(f.calls).toHaveLength(0);
});

test('bounded responses and invalid JSON fail without leaking the body', async () => {
  for (const body of ['x'.repeat(200), '{secret-invalid-json']) {
    const f = fixture({
      maxResponseBytes: 100,
      fetch: async () => new Response(body),
    });

    await expect(
      f.resource.identify({ signal: signal() }),
    ).rejects.toBeInstanceOf(SalesforceSourceError);
  }
});

test('operation deadline includes an uncooperative credential callback', async () => {
  let active: AbortSignal | undefined;
  const f = fixture({
    timeoutMs: 10,
    credentials: ({ signal }) => {
      active = signal;

      return new Promise(() => {});
    },
  });

  await expect(
    f.resource.identify({ signal: signal() }),
  ).rejects.toBeInstanceOf(SalesforceSourceError);
  expect(active?.aborted).toBe(true);
  expect(f.calls).toHaveLength(0);
});

test('cancellation reaches outstanding transport and preserves caller reason', async () => {
  let active: AbortSignal | undefined;
  const caller = new AbortController();
  const f = fixture({
    fetch: async (_, init) => {
      active = init?.signal ?? undefined;

      return new Promise(() => {});
    },
  });
  const pending = f.resource.fetch(accountId, { signal: caller.signal });
  const assertion = expect(pending).rejects.toThrow('caller stopped');

  caller.abort(new Error('caller stopped'));
  await assertion;
  expect(active?.aborted).toBe(true);
});

test('pre-aborted work never resolves credentials', async () => {
  const resolve = vi.fn(() => credentials);
  const connection = salesforce({ apiVersion: '67.0', credentials: resolve });

  await expect(
    connection
      .resource('Account', { fields: [] })
      .identify({ signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(resolve).not.toHaveBeenCalled();
});

test('timeout cancels a stalled response stream', async () => {
  const cancelled = vi.fn();
  const f = fixture({
    timeoutMs: 10,
    fetch: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
          },
          cancel: cancelled,
        }),
      ),
  });

  await expect(
    f.resource.identify({ signal: signal() }),
  ).rejects.toBeInstanceOf(SalesforceSourceError);
  expect(cancelled).toHaveBeenCalledTimes(1);
});

test.each(['not-an-org', '001000000000001AAA', '00D000000000001AAA'])(
  'rejects malformed identity %s before reading data',
  async (identity) => {
    const f = fixture();

    f.setOrg(identity);
    await expect(
      f.resource.fetch(accountId, { signal: signal() }),
    ).rejects.toBeInstanceOf(SalesforceSourceError);
    expect(f.calls).toHaveLength(1);
  },
);
