import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

export default defineConfig(({ command }) => {
  const nonce = command === 'serve' ? randomBytes(18).toString('hex') : undefined
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
            handler: (html) => html
              .replace('__STORYWEAVE_SCRIPT_SOURCES__', nonce ? `'self' 'nonce-${nonce}'` : "'self'")
              .replace('__STORYWEAVE_CONNECT_SOURCES__', nonce ? "'self' ws://127.0.0.1:5173" : "'none'"),
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
