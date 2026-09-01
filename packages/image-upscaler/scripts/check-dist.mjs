#!/usr/bin/env node
/**
 * Post-build sanity check.
 *
 * A library build can succeed and still be broken in ways `tsc` cannot see: a
 * missing entry point, a declaration file that was not emitted, an IIFE that
 * forgot to install its global, or - the one that actually bit during
 * development - the ONNX Runtime getting statically inlined into the classical
 * bundle, quietly adding megabytes for consumers who never asked for AI.
 */
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const REQUIRED = [
  'index.js',
  'index.cjs',
  'index.d.ts',
  'ai.js',
  'ai.cjs',
  'ai.d.ts',
  'worker.js',
  'image-upscaler.js',
  'image-upscaler.min.js',
  'image-upscaler.esm.js',
];

const failures = [];

for (const file of REQUIRED) {
  try {
    const info = await stat(join(dist, file));
    if (info.size === 0) failures.push(`${file} is empty`);
  } catch {
    failures.push(`${file} is missing`);
  }
}

if (failures.length === 0) {
  const iife = await readFile(join(dist, 'image-upscaler.min.js'), 'utf8');
  if (!iife.includes('ImageUpscaler')) {
    failures.push('image-upscaler.min.js never mentions ImageUpscaler, so the global cannot exist');
  }
  // An IIFE that starts with `import` was not actually bundled.
  if (/^\s*import\s/m.test(iife.slice(0, 2000))) {
    failures.push('image-upscaler.min.js contains a static import; it is not self-contained');
  }

  const index = await readFile(join(dist, 'index.js'), 'utf8');
  if (/from\s*["']onnxruntime-web["']/.test(index)) {
    failures.push('index.js statically imports onnxruntime-web; the AI runtime must stay lazy');
  }

  const sizes = await Promise.all(
    REQUIRED.map(async (file) => [file, (await stat(join(dist, file))).size]),
  );
  const width = Math.max(...sizes.map(([file]) => file.length));
  for (const [file, size] of sizes) {
    console.log(`  ${file.padEnd(width)}  ${(size / 1024).toFixed(1)} KiB`);
  }
}

if (failures.length > 0) {
  console.error('\nBuild verification failed:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log('\nBuild verification passed.');
