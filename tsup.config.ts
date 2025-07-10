import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/bot.ts'],
    format: ['esm'],
    splitting: false,
    shims: false,
    clean: true,
    dts: false,
    target: 'node18',
    outDir: 'dist',
    sourcemap: true,
    platform: 'node'
});