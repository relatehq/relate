let mode;

process.on('message', (request) => {
  if (request.kind === 'open') {
    mode = request.path;

    if (mode === 'startup-timeout') return;

    process.send({ kind: 'ready' });

    return;
  }

  if (mode === 'crash') {
    process.stderr.write('native crash marker\n', () => process.exit(7));

    return;
  }

  if (request.kind === 'describe' && request.resource.table === 'hang') return;

  process.send({
    kind: 'result',
    value: {
      rows: [{ slot: 0, values: [process.pid] }],
      readAt: new Date().toISOString(),
    },
  });
});
process.on('disconnect', () => process.exit(0));
