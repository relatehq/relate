const objectDetails = {
  customer: {
    name: 'Customer',
    kind: 'Composite object',
    description:
      'One customer, fields from Salesforce, Stripe, BigQuery, and S3. Each field keeps its source; the object brings them together.',
  },
  invoice: {
    name: 'Invoice',
    kind: 'Source-backed object',
    description:
      'Invoices stay in your billing database. A typed reference connects each invoice to its customer across systems.',
  },
  review: {
    name: 'AccountReview',
    kind: 'Native object',
    description:
      'Reviews live in Relate. Native actions create records with access checks, transactions, and recoverable receipts.',
  },
};
const nodes = document.querySelectorAll('[data-object]');
const detail = document.querySelector('#object-detail');

for (const node of nodes) {
  node.addEventListener('click', () => {
    const object = objectDetails[node.dataset.object];

    for (const other of nodes) {
      other.setAttribute('aria-pressed', String(other === node));
    }

    const label = document.createElement('span');
    const kind = document.createElement('span');
    const description = document.createElement('p');

    label.className = 'detail-label';
    label.textContent = `${object.name} `;
    kind.textContent = `· ${object.kind}`;
    description.textContent = object.description;
    label.append(kind);
    detail.replaceChildren(label, description);
  });
}
