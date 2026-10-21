import { startApp } from '@relate/node';
import { decodeComputed } from 'relate/consumer';
import { app, declaredApp } from './app.js';
import { actors } from './graph.js';
import { seed, seedDeclared } from './seed.js';
import { octoberLogins, lastLogin } from './queries.js';

const runtime = await startApp(app);

try {
  await seed(runtime);
  const customer = runtime.as(actors.ana).objects.Customer;
  const page = await customer.query({
    select: ['name'],
    compute: { loginsOct: octoberLogins, lastLogin },
    orderBy: [{ field: 'lastLogin', direction: 'desc' }],
  });

  console.log('October logins and latest login, in authorized order:');
  console.table(page.data.map((row) => row.data));
  const inactive = await customer.query({
    select: ['name'],
    compute: { loginsOct: octoberLogins },
    where: { loginsOct: { eq: '0' } },
  });

  console.log(
    'No October logins:',
    inactive.data.map((row) => row.data.name).join(', '),
  );
  const decoded = decodeComputed(page.data[0]!);

  console.log('Decoded Acme:', decoded.loginsOct, decoded.lastLogin);
  const fin = runtime.as(actors.fin).objects.Customer.describe();

  console.log(
    'Fin can discover the events association:',
    Boolean(fin?.datasets?.events),
  );
} finally {
  await runtime.close();
}

const extended = await startApp(declaredApp);

try {
  await seedDeclared(extended);
  const page = await extended.as(actors.ana).objects.Customer.query({
    select: ['name', 'loginCount'],
    orderBy: [{ field: 'loginCount', direction: 'desc' }],
  });

  console.log('Reusable declared property: all-time logins');
  console.table(page.data.map((row) => row.data));
} finally {
  await extended.close();
}
