const $ = (id) => document.getElementById(id);
let actor = 'ana';
let lastSubmission = null;
let busy = false;
let loaded = false;
const describe = (value) => JSON.stringify(value, null, 2);
const money = (major, currency) =>
  new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(major);
const withheld = (record, field) =>
  record.meta?.fields?.[field]?.status === 'forbidden'
    ? 'Withheld'
    : 'Unavailable';
const feedback = (message) => {
  $('feedback').textContent = message;
};

async function api(input) {
  const response = await fetch('/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const result = await response.json();

  if (!response.ok) throw new Error(result.error);

  return result;
}

function controls() {
  document.querySelectorAll('button, select, input, textarea').forEach((el) => {
    el.disabled = busy;
  });
  $('save').disabled = busy || !loaded || actor !== 'ana';
  $('note').disabled = busy || !loaded || actor !== 'ana';
  $('retry').disabled =
    busy || !loaded || !lastSubmission || lastSubmission.actor !== actor;
}

async function run(work) {
  if (busy) return;

  busy = true;
  controls();

  try {
    await work();
  } catch (error) {
    feedback(error.message);
  } finally {
    busy = false;
    controls();
  }
}

function textElement(tag, text, className) {
  const el = document.createElement(tag);

  el.textContent = text;

  if (className) el.className = className;

  return el;
}

async function read(refresh = false) {
  const result = await api({ operation: 'read', actor, refresh });

  $('evidence').textContent = describe(result);
  $('calls').textContent =
    `const { objects } = relate.as(${actor});\n\nawait objects.Customer.get(customerId, { refresh: ${refresh} });\nawait objects.Customer.traverse.invoices(customerId, {\n  select: ['id', 'status', 'totalMinor', 'currency'],\n  refresh: ${refresh}\n});\n// Temporary demo index: IDs created through this running example only.\n// Native-reference traversal is not implemented yet; each get is authorized.\nawait Promise.all(reviewIds.map(id => objects.AccountReview.get(id)));`;
  const customer = result.customer;

  $('name').textContent =
    customer.status === 'ok'
      ? (customer.data.name ?? 'Name unavailable')
      : 'Customer unavailable';
  $('status').textContent =
    customer.status === 'ok'
      ? (customer.data.status ?? 'Unavailable')
      : 'Unavailable';
  $('avatar').textContent = $('name').textContent.charAt(0).toUpperCase();
  // The CRM revenue field carries no currency; the demo CRM reports GBP.
  $('revenue').textContent =
    customer.status !== 'ok'
      ? 'Revenue unavailable'
      : typeof customer.data.revenue === 'number'
        ? `Revenue ${money(customer.data.revenue, 'GBP')}`
        : `Revenue ${withheld(customer, 'revenue').toLowerCase()}`;

  if (!$('crm-name').value && customer.status === 'ok' && customer.data.name)
    $('crm-name').value = customer.data.name;

  $('role').textContent =
    actor === 'ana'
      ? 'Ana manages this account and can add reviews. Financial fields are withheld by Relate.'
      : 'Fin can see financial fields. Adding account reviews is reserved for account managers.';
  $('review-hint').textContent =
    actor === 'ana'
      ? 'Retrying uses the original input and key. It returns the same receipt.'
      : 'Switch to Ana to add an account review.';
  $('invoices').replaceChildren();
  // Relate orders by object ID, which is random per launch; sort for stable labels.
  const invoices = [...result.invoices.data].sort((a, b) =>
    String(a.data.status).localeCompare(String(b.data.status)),
  );

  invoices.forEach((invoice, index) => {
    const row = document.createElement('tr');

    row.append(textElement('td', `Invoice ${index + 1}`));
    const status = document.createElement('td');

    status.append(
      textElement(
        'span',
        invoice.data.status ?? 'Unavailable',
        `badge ${invoice.data.status === 'Overdue' ? 'overdue' : ''}`,
      ),
    );
    row.append(status);
    const amount = invoice.data.totalMinor;

    row.append(
      textElement(
        'td',
        typeof amount === 'number'
          ? money(amount / 100, invoice.data.currency ?? 'GBP')
          : withheld(invoice, 'totalMinor'),
        'amount',
      ),
    );
    $('invoices').append(row);
  });
  $('reviews').replaceChildren();

  if (!result.reviews.data.length)
    $('reviews').append(
      textElement(
        'p',
        'No reviews yet. Add the first next step for this account.',
        'empty',
      ),
    );

  result.reviews.data.forEach((review) => {
    const entry = textElement('article', '', 'review');

    entry.append(
      textElement('p', review.data.note ?? 'Note unavailable'),
      textElement(
        'small',
        review.data.author === 'ana'
          ? 'Ana · Account manager'
          : (review.data.author ?? 'Author unavailable'),
      ),
    );
    $('reviews').append(entry);
  });
  loaded = true;
}

function clearAccount() {
  loaded = false;
  $('name').textContent = 'Account not loaded';
  $('status').textContent = 'Unavailable';
  $('revenue').textContent = 'Revenue unavailable';
  $('invoices').replaceChildren();
  $('reviews').replaceChildren();
  $('evidence').textContent = '';
  $('calls').textContent = '';
  $('receipt').textContent = 'Add a review to see its receipt.';
  $('receipt-panel').open = false;
  $('note').value = '';
  $('review-hint').textContent = 'Load this account before adding a review.';
  $('role').textContent = 'Loading data for the selected demo user…';
}

$('actor').addEventListener('change', () =>
  run(async () => {
    actor = $('actor').value;
    clearAccount();
    await read();
    feedback('Access rules applied for the selected demo user.');
  }),
);
$('refresh').addEventListener('click', () =>
  run(async () => {
    await read(true);
    feedback('Read again from the CRM and SQLite billing sources.');
  }),
);

async function submit(request, retry = false) {
  const receipt = await api(request);

  await read();
  $('receipt').textContent =
    `await relate.as(${actor}).actions.addAccountReview({\n  input: { customer: customerId, note: ${describe(request.note)} },\n  idempotencyKey: ${describe(request.idempotencyKey)}\n});\n\n${describe(receipt)}`;
  $('receipt-panel').open = true;
  feedback(
    receipt.state === 'succeeded'
      ? retry
        ? 'Recovered the same receipt. No duplicate review was created.'
        : 'Review added to the customer account.'
      : 'The action did not succeed. See the receipt below.',
  );
}

$('review-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    const note = $('note').value.trim();

    if (!note) throw new Error('Enter a next step before adding a review.');

    lastSubmission = {
      operation: 'review',
      actor,
      note,
      idempotencyKey: crypto.randomUUID(),
    };
    await submit(lastSubmission);
    $('note').value = '';
  });
});
$('retry').addEventListener('click', () =>
  run(() => submit(lastSubmission, true)),
);
$('rename-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    await api({ operation: 'rename', name: $('crm-name').value });
    feedback(
      'CRM updated. Choose “Refresh from sources” to read the new name.',
    );
  });
});
void run(async () => {
  let configError;

  try {
    const response = await fetch('/config');

    if (!response.ok)
      throw new Error(
        'Model inspector link unavailable. Check the terminal and reload.',
      );

    const config = await response.json();

    if (typeof config.inspectorUrl !== 'string')
      throw new Error(
        'Model inspector link unavailable. Check the terminal and reload.',
      );

    const url = new URL(config.inspectorUrl);

    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !url.hash.startsWith('#token=')
    )
      throw new Error(
        'Model inspector link unavailable. Check the terminal and reload.',
      );

    $('inspector').href = url.href;
  } catch (error) {
    $('inspector').removeAttribute('href');
    $('inspector').textContent = 'Inspector unavailable';
    configError = error;
  }

  await read();

  if (configError) throw configError;
});
