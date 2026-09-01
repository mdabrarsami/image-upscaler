/**
 * Rendering for benchmark records.
 *
 * Separate from the driver so a report can be regenerated from a stored
 * `latest.json` without re-running the measurements. That matters more than it
 * sounds: the AI cases take the better part of an hour, and a formatting fix
 * should not cost an hour of CPU or, worse, tempt someone into hand-editing
 * numbers into the documentation.
 */

export function fmt(value, digits = 1) {
  if (value === undefined || value === null || !Number.isFinite(value)) return '-';
  return value.toFixed(digits);
}

export function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells) =>
    `| ${cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join(' | ')} |`;
  return [
    line(headers),
    `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
    ...rows.map(line),
  ].join('\n');
}

export function renderMarkdown(record) {
  const parts = [];

  parts.push('# Benchmark results\n');
  parts.push(`Generated ${record.generatedAt}\n`);

  parts.push('## Environment\n');
  parts.push(
    table(
      ['Item', 'Value'],
      [
        ['Chromium', record.environment.chromium],
        ['Node', record.environment.node],
        ['Platform', record.environment.platform],
        ['Logical cores', String(record.environment.capabilities.hardwareConcurrency)],
        ['WebGPU', String(record.environment.capabilities.webGPU)],
        ['WebGL2', String(record.environment.capabilities.webGL2)],
        ['WASM SIMD', String(record.environment.capabilities.wasmSimd)],
        [
          'Memory budget',
          `${Math.round(record.environment.capabilities.estimatedMemory / 1e6)} MB (${
            record.environment.capabilities.estimatedMemoryIsReported ? 'reported' : 'estimated'
          })`,
        ],
      ],
    ),
  );

  parts.push('\n\n## Throughput\n');
  parts.push('Median wall-clock time for a complete call, decode and PNG encode included.\n');
  parts.push(
    table(
      ['Source', 'Scale', 'Engine', 'Mode', 'Runtime', 'Tiles', 'Median ms', 'MP/s', 'Result'],
      record.throughput.map((r) =>
        r.ok
          ? [
              `${r.width}x${r.height}`,
              `${r.scale}x`,
              r.engineUsed,
              r.mode,
              r.runtime,
              String(r.tiles > 1 ? r.tiles : 1),
              fmt(r.median, 0),
              fmt(r.megapixelsPerSecond, 2),
              `${r.outputWidth}x${r.outputHeight}`,
            ]
          : [
              `${r.width}x${r.height}`,
              `${r.scale}x`,
              r.engine,
              r.mode,
              '-',
              '-',
              '-',
              '-',
              `refused: ${r.code}`,
            ],
      ),
    ),
  );

  if (record.limits && record.limits.length > 0) {
    parts.push('\n\n## Limits\n');
    parts.push(
      'Sizes where the question is whether the library copes at all, rather than how fast. Not timed against a baseline: at these resolutions the browser PNG encoder dominates the measurement.\n',
    );
    parts.push(
      table(
        ['Source', 'Scale', 'Output MP', 'Outcome', 'Time', 'Tiles'],
        record.limits.map((r) => [
          `${r.width}x${r.height}`,
          `${r.scale}x`,
          fmt(r.outputMegapixels, 0),
          r.ok ? 'handled' : `refused: ${r.code}`,
          r.ok ? `${fmt(r.median, 0)} ms` : '-',
          r.ok ? String(r.tiles > 1 ? r.tiles : 1) : '-',
        ]),
      ),
    );
  }

  parts.push('\n\n## Quality\n');
  parts.push(
    'Each source is rendered at full size, downscaled, then enlarged back and compared with the original. Higher PSNR and SSIM are better; lower MAE and MSE are better.\n',
  );
  for (const group of record.quality) {
    parts.push(`\n### ${group.width}x${group.height} at ${group.scale}x\n`);
    parts.push(
      table(
        ['Method', 'PSNR dB', 'SSIM', 'MAE', 'MSE'],
        group.rows.map((row) =>
          row.ok
            ? [row.label, fmt(row.psnr, 2), fmt(row.ssim, 4), fmt(row.mae, 2), fmt(row.mse, 1)]
            : [row.label, 'failed', row.code, '-', '-'],
        ),
      ),
    );
  }

  return `${parts.join('\n')}\n`;
}
