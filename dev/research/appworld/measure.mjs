import { writeFile } from 'node:fs/promises';
import { createSnapshot } from './graph.mjs';

// Synthetic scaling diagnostics, deliberately separate from AppWorld task scores.
const measurements = [];

for (const size of [10, 100, 500]) {
  const rows = {
    Playlist: [{ sourceId: 'collection', title: 'Synthetic collection' }],
    Song: Array.from({ length: size }, (_, i) => ({
      sourceId: String(i),
      title: `Song ${i}`,
      albumId: 'album',
      duration: 180,
      genre: 'test',
      releaseDate: '2020-01-01',
      likeCount: i,
      playCount: i * 2,
      artistsJson: '[]',
    })),
    Membership: Array.from({ length: size }, (_, i) => ({
      sourceId: `collection:${i}`,
      playlist: 'collection',
      song: String(i),
    })),
  };
  const snapshot = await createSnapshot(rows);

  try {
    for (const condition of ['flat', 'full', 'compact']) {
      for (const select of [undefined, ['sourceId', 'title', 'likeCount']]) {
        const value = await snapshot.execute({
          op: 'list',
          kind: 'Song',
          condition,
          select,
        });

        measurements.push({
          size,
          condition,
          selected: select ?? 'all',
          bytes: Buffer.byteLength(JSON.stringify(value)),
          count: value.result.data.length,
        });
      }
    }

    const page = await snapshot.execute({
      op: 'traverse',
      kind: 'Playlist',
      id: 'collection',
      relation: 'memberships',
      condition: 'compact',
      select: ['sourceId'],
    });

    if (page.result.data.length !== size)
      throw new Error('Traversal lost records');
  } finally {
    await snapshot.close();
  }
}

await writeFile(
  new URL('./.local/scaling.json', import.meta.url),
  JSON.stringify(measurements, null, 2) + '\n',
);
console.log(JSON.stringify(measurements));
