/** Exercise the actual browser script with a minimal DOM, without external browser services. */
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect, it, vi } from 'vitest';

class Element {
  value = '';
  disabled = false;
  open = false;
  href: string | undefined;
  className = '';
  children: Element[] = [];
  private text = '';
  listeners = new Map<string, () => Promise<void>>();
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join('');
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren() {
    this.text = '';
    this.children = [];
  }
  addEventListener(name: string, listener: () => Promise<void>) {
    this.listeners.set(name, listener);
  }
  removeAttribute(name: string) {
    if (name === 'href') this.href = undefined;
  }
}

const response = (data: unknown, ok = true) => ({ ok, json: async () => data });
const account = (actor: 'ana' | 'fin') => ({
  customer: {
    status: 'ok',
    data: {
      name: 'Mothlight',
      status: 'active',
      ...(actor === 'fin' ? { revenue: 2000000 } : {}),
    },
    meta: {
      fields: {
        revenue: { status: actor === 'fin' ? 'available' : 'forbidden' },
      },
    },
  },
  invoices: {
    data: [
      {
        data: { status: 'Paid' },
        meta: { fields: {} },
      },
      {
        data: {
          status: 'Overdue',
          ...(actor === 'ana' ? { totalMinor: 480000, currency: 'GBP' } : {}),
        },
        meta: {
          fields: {
            totalMinor: { status: actor === 'ana' ? 'available' : 'forbidden' },
          },
        },
      },
    ],
  },
  reviews: { data: [] },
});

async function start(fetch: ReturnType<typeof vi.fn>) {
  const elements = new Map<string, Element>();
  const element = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());

    return elements.get(id)!;
  };
  const source = await readFile(
    new URL('../src/ui/app.js', import.meta.url),
    'utf8',
  );

  runInNewContext(source, {
    document: {
      getElementById: element,
      createElement: () => new Element(),
      querySelectorAll: () => [...elements.values()],
    },
    fetch,
    URL,
    Intl,
    console,
  });
  await vi.waitFor(() => expect(element('name').textContent).toBe('Mothlight'));
  await vi.waitFor(() => expect(element('actor').disabled).toBe(false));

  return element;
}

it('clears the previous role data and evidence before a failed role switch', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({ inspectorUrl: 'http://127.0.0.1:4318/#token=abc' }),
    )
    .mockResolvedValueOnce(response(account('ana')))
    .mockResolvedValueOnce(response({ error: 'Source unavailable' }, false));
  const element = await start(fetch);

  expect(element('invoices').textContent).toContain('4,800');
  expect(element('evidence').textContent).toContain('480000');
  element('receipt').textContent = 'Previous receipt';
  element('actor').value = 'fin';
  await element('actor').listeners.get('change')!();
  expect(element('invoices').textContent).toBe('');
  expect(element('evidence').textContent).toBe('');
  expect(element('calls').textContent).toBe('');
  expect(element('receipt').textContent).not.toContain('Previous receipt');
  expect(element('feedback').textContent).toBe('Source unavailable');
  expect(element('save').disabled).toBe(true);
});

it.each([
  response({ error: 'Unavailable' }, false),
  response({}),
  response({ inspectorUrl: 'javascript:alert(1)' }),
])(
  'keeps the inspector link disabled when configuration fails',
  async (config) => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(config)
      .mockResolvedValueOnce(response(account('ana')));
    const element = await start(fetch);

    expect(element('inspector').href).toBeUndefined();
    expect(element('inspector').textContent).toBe('Inspector unavailable');
    expect(element('feedback').textContent).toContain(
      'Model inspector link unavailable',
    );
    expect(element('invoices').textContent).toContain('4,800');
  },
);

it('orders invoices by status and shows financial fields by role', async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      response({ inspectorUrl: 'http://127.0.0.1:4318/#token=abc' }),
    )
    .mockResolvedValueOnce(response(account('ana')))
    .mockResolvedValueOnce(response(account('fin')));
  const element = await start(fetch);

  expect(element('invoices').textContent).toMatch(
    /^Invoice 1Overdue.*Invoice 2Paid/,
  );
  expect(element('revenue').textContent).toBe('Revenue withheld');
  expect(element('invoices').textContent).toContain('4,800');
  expect(element('save').disabled).toBe(false);
  expect(element('avatar').textContent).toBe('M');
  expect(element('crm-name').value).toBe('Mothlight');

  element('actor').value = 'fin';
  await element('actor').listeners.get('change')!();
  expect(element('revenue').textContent).toBe('Revenue £2,000,000.00');
  expect(element('invoices').textContent).toContain('Withheld');
  expect(element('invoices').textContent).not.toContain('4,800');
  expect(element('evidence').textContent).not.toContain('480000');
  expect(element('save').disabled).toBe(true);
});
