#!/usr/bin/env node
/**
 * Splice the latest measured results into docs/PERFORMANCE.md.
 *
 * Documentation that quotes performance numbers goes stale the moment the code
 * changes, and stale numbers are worse than none. Keeping the tables generated
 * means the only way they can be wrong is if nobody re-ran the benchmark, which
 * the timestamp makes obvious.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarkdown } from './report.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RECORD = resolve(ROOT, 'benchmarks/results/latest.json');
const RESULTS = resolve(ROOT, 'benchmarks/results/latest.md');
const TARGET = resolve(ROOT, 'docs/PERFORMANCE.md');

const BEGIN = '<!-- RESULTS:BEGIN -->';
const END = '<!-- RESULTS:END -->';

// Rendered from the JSON rather than read from the Markdown, so a change to
// the report format can be applied to results that already exist instead of
// costing another full benchmark run.
let results;
try {
  const record = JSON.parse(await readFile(RECORD, 'utf8'));
  results = renderMarkdown(record);
  await writeFile(RESULTS, results);
} catch (error) {
  console.error(`Could not render ${RECORD}: ${error.message}`);
  console.error('Run `npm run benchmark` first.');
  process.exit(1);
}

const doc = await readFile(TARGET, 'utf8');
const start = doc.indexOf(BEGIN);
const end = doc.indexOf(END);
if (start === -1 || end === -1) {
  console.error(`${TARGET} is missing its ${BEGIN} / ${END} markers.`);
  process.exit(1);
}

// Demote the generated headings by one level so they nest under this
// document's own structure instead of competing with it.
const body = results
  .replace(/^# Benchmark results\n/m, '')
  .replace(/^## /gm, '### ')
  .replace(/^### Environment/m, '### Measured on')
  .trim();

const updated =
  `${doc.slice(0, start + BEGIN.length)}\n\n${body}\n\n${doc.slice(end)}`;

await writeFile(TARGET, updated);
console.log(`Updated ${TARGET} from ${RESULTS}`);
