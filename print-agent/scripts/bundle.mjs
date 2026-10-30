// Bundles the agent into one CommonJS file (dist/agent.cjs) for Node SEA / plain node.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
mkdirSync('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/agent.cjs',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
});
