import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

function standaloneSshHost(): Plugin {
  return {
    name: 'verify-standalone-ssh-host',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || output.name !== 'ssh-host') continue
        if (output.dynamicImports.length || output.imports.some((specifier) => !specifier.startsWith('node:'))) {
          this.error('SSH host must be one self-contained file with Node built-in imports only')
        }
      }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@earendil-works/pi-ai'] }), standaloneSshHost()],
    resolve: {
      alias: {
        '@shared': resolve('packages/shared'),
      },
    },
    build: {
      rollupOptions: {
        external: [
          'electron',
          '@earendil-works/pi-ai',
          '@earendil-works/pi-coding-agent',
          'better-sqlite3',
        ],
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          worker: resolve(__dirname, 'src/worker/index.ts'),
          preview: resolve(__dirname, 'src/preview/index.ts'),
          'preview-wsl': resolve(__dirname, 'src/preview/wsl.ts'),
          'ssh-host': resolve(__dirname, 'src/ssh-host/entry.ts'),
        },
        output: {
          entryFileNames: (chunk) => {
            return chunk.name === 'worker' || chunk.name === 'preview' || chunk.name === 'preview-wsl' || chunk.name === 'ssh-host'
              ? '[name].mjs'
              : '[name].js'
          },
          format: 'es',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('packages/shared'),
      },
    },
    build: {
      rollupOptions: {
        external: ['electron'],
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          notification: resolve(__dirname, 'src/preload/notification.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('packages/shared'),
        '@extension-compat': resolve('src/extension-compat'),
      },
    },
    plugins: [react()],
    build: {
      modulePreload: {
        resolveDependencies(filename, deps) {
          if (filename.startsWith('assets/index-')) {
            return deps.filter((dep) => !dep.startsWith('assets/shiki-'))
          }
          return deps
        },
      },
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
        output: {
          manualChunks(id) {
            if (id.includes('node_modules/shiki') || id.includes('@shikijs')) return 'shiki'
            if (id.includes('node_modules/react-dom')) return 'react-dom'
            if (id.includes('node_modules/react/')) return 'react'
          },
        },
      },
    },
  },
})
