#!/usr/bin/env node
/**
 * Static file server for the browser test suite and the demos.
 *
 * Written by hand rather than pulled from npm for two reasons: the tests need
 * control over response headers (cross-origin isolation, and a switch to
 * simulate an offline model host), and a dev-server dependency would be one
 * more thing between the library and the thing being verified.
 */
import { createReadStream, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PORT = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.ts': 'text/plain; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://localhost:${PORT}`);

  // Cross-origin isolation, so onnxruntime-web can use threads and
  // SharedArrayBuffer. Opt-in per request: one of the tests checks the
  // single-threaded path too.
  if (url.searchParams.has('isolate')) {
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  // Contain the served tree. `normalize` collapses `..`; the prefix check
  // rejects anything that still escapes.
  const target = join(ROOT, normalize(pathname).replace(/^([/\\])+/, ''));
  if (!target.startsWith(ROOT + sep) && target !== ROOT) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const info = await fs.stat(target);
    if (info.isDirectory()) {
      response.writeHead(302, { Location: `${pathname}/` }).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      // The tests reload pages and expect fresh bundles.
      'Cache-Control': 'no-store',
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${pathname}`);
  }
});

server.listen(PORT, () => {
  process.stdout.write(`test server listening on http://localhost:${PORT}\n`);
});
