// Independently compile with suppression comments removed, without editing files.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const directory = path.dirname(fileURLToPath(import.meta.url));
const configPath = path.resolve(directory, '../../../../tsconfig.tests.json');
const casesPath = path.join(directory, 'policies.ts');
const config = ts.readConfigFile(configPath, ts.sys.readFile);

if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, '\n'),
  );

const parsed = ts.parseJsonConfigFileContent(
  config.config,
  ts.sys,
  path.dirname(configPath),
);

if (parsed.errors.length) throw new Error('Invalid fixture tsconfig');

const original = fs.readFileSync(casesPath, 'utf8');
const lines = original.split('\n');
const expectedLines = lines.flatMap((line, index) =>
  line.includes('@ts-expect-error') ? [index + 2] : [],
);
const unsuppressed = original.replace(/^.*@ts-expect-error.*$/gm, '');
const host = ts.createCompilerHost(parsed.options);
const readFile = host.readFile.bind(host);

host.readFile = (name) =>
  path.resolve(name) === casesPath ? unsuppressed : readFile(name);

const program = ts.createProgram(parsed.fileNames, parsed.options, host);
const diagnostics = ts.getPreEmitDiagnostics(program);
const actualLines = new Set();

for (const diagnostic of diagnostics) {
  const line =
    diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start).line + 1
      : undefined;

  if (
    !diagnostic.file ||
    path.resolve(diagnostic.file.fileName) !== casesPath ||
    !expectedLines.includes(line)
  ) {
    throw new Error(
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
  }

  actualLines.add(line);
}

for (const line of expectedLines) {
  if (!actualLines.has(line))
    throw new Error(`Expected rejection missing at policies.ts:${line}`);
}

console.log(
  `Verified ${actualLines.size} negative cases independently with suppression comments removed.`,
);
