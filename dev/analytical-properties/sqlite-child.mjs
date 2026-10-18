import { DatabaseSync } from 'node:sqlite';

const database = new DatabaseSync(process.argv[2], { readOnly: true });

process.on('message', ({ text, values }) => {
  try {
    const statement = database.prepare(text);

    statement.setReadBigInts(true);
    process.send({ rows: statement.all(...values) });
  } catch (error) {
    process.send({ error: String(error) });
  } finally {
    database.close();
    process.disconnect();
  }
});
process.send({ ready: true });
