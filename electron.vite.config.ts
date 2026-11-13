import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { version } from './package.json'

export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(18).toString('hex') : undefined
  const builtAt = new Date()
  const buildTime = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', dateStyle: 'short', timeStyle: 'medium',
  }).format(builtAt)
  const windowTitle = `织章 · StoryWeave v${version} · ${command === 'serve' ? '开发' : '构建'} ${buildTime} (UTC+8)`
  return {
    main: {
      build: {
        outDir: 'out/main',
        emptyOutDir: false,
        rollupOptions: {
          input: {
            index: resolve(__dirname, 'src/desktop/main/index.ts'),
            service: resolve(__dirname, 'src/desktop/service/index.ts'),
          },
          external: ['better-sqlite3'],
          output: {
            format: 'cjs',
            entryFileNames: '[name].js',
            chunkFileNames: 'chunks/[name]-[hash].js',
          },
        },
      },
    },
    preload: {
      build: {
        outDir: 'out/preload',
        emptyOutDir: false,
        rollupOptions: {
          input: resolve(__dirname, 'src/desktop/preload/index.ts'),
          output: {
            format: 'cjs',
            entryFileNames: 'index.js',
            codeSplitting: false,
          },
        },
      },
    },
    renderer: {
      root: resolve(__dirname, 'src/renderer'),
      html: { cspNonce: nonce },
      plugins: [
        react(),
        {
          name: 'storyweave-content-security-policy',
          transformIndexHtml: {
            order: 'pre',
            handler: (html) => ({
              html: html
                .replace('__STORYWEAVE_SCRIPT_SOURCES__', nonce ? `'self' 'nonce-${nonce}'` : "'self'")
                .replace('__STORYWEAVE_CONNECT_SOURCES__', nonce ? "'self' ws://127.0.0.1:5173" : "'none'")
                .replace('__STORYWEAVE_WINDOW_TITLE__', windowTitle),
              tags: [
                { tag: 'meta', attrs: { name: 'storyweave-version', content: version } },
                { tag: 'meta', attrs: { name: 'storyweave-built-at', content: builtAt.toISOString() } },
              ],
            }),
          },
        },
      ],
      server: { host: '127.0.0.1', port: 5173, strictPort: true },
      build: {
        outDir: resolve(__dirname, 'out/renderer'),
        emptyOutDir: false,
      },
    },
  }
})
