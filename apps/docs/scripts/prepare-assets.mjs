import { copyFile, mkdir } from 'node:fs/promises';

const source = new URL('../../../assets/brand/', import.meta.url);
const destination = new URL('../public/assets/brand/', import.meta.url);

await mkdir(destination, { recursive: true });

for (const name of [
  'relate-logo-light.svg',
  'relate-logo-dark.svg',
  'favicon.svg',
]) {
  await copyFile(new URL(name, source), new URL(name, destination));
}
