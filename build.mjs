import esbuild from 'esbuild';
import fs from 'node:fs';

const watch = process.argv.includes('--watch');
const define = {
  __SENTRY_DSN__: JSON.stringify(process.env.TASKPILOT_SENTRY_DSN ?? ''),
  __DEFAULT_API_URL__: JSON.stringify(process.env.TASKPILOT_API_URL ?? 'http://localhost:8787'),
  'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production'),
};
const common = { bundle: true, sourcemap: watch ? 'inline' : false, minify: !watch, target: 'chrome121', define, logLevel: 'info', jsx: 'automatic' };

fs.rmSync('dist', { recursive: true, force: true });
fs.cpSync('public', 'dist', { recursive: true });

const builds = [
  // Service worker: one ES module file.
  { ...common, entryPoints: { background: 'src/background/index.ts' }, outdir: 'dist', format: 'esm' },
  // Content script: classic script (content scripts cannot be ES modules).
  { ...common, entryPoints: { content: 'src/content/index.ts' }, outdir: 'dist', format: 'iife' },
  // Side panel: React app; splitting keeps the optional Sentry SDK out of the main bundle.
  { ...common, entryPoints: { 'sidepanel/main': 'src/sidepanel/main.tsx' }, outdir: 'dist', format: 'esm', splitting: true, chunkNames: 'sidepanel/chunks/[name]-[hash]' },
];

if (watch) {
  for (const b of builds) await (await esbuild.context(b)).watch();
  console.log('watching… reload the extension at chrome://extensions after changes');
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
