// Builds the three bundles (main, preload, renderer) into dist/ with esbuild.
import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
const common = { bundle: true, sourcemap: true, logLevel: 'warning', target: 'es2022' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/main.tsx'], outfile: 'dist/renderer/app.js', platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.wgsl': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, minify: true }),
]);
mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
// MediaPipe runtime and models for webcam face tracking and cutout (Apache-2.0, run locally).
cpSync('node_modules/@mediapipe/tasks-vision/wasm', 'dist/renderer/mediapipe/wasm', { recursive: true });
cpSync('assets/models', 'dist/renderer/mediapipe', { recursive: true });
console.log('built dist/');
