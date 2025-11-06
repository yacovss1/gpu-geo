import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'MapActiveWorkTS',
      fileName: 'map-active-work-ts',
      formats: ['es', 'umd']
    },
    rollupOptions: {
      external: [],
      output: {
        globals: {}
      }
    },
    minify: 'terser',
    sourcemap: true,
    target: 'esnext'
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@types': resolve(__dirname, 'src/types'),
      '@core': resolve(__dirname, 'src/core'),
      '@utils': resolve(__dirname, 'src/utils'),
      '@examples': resolve(__dirname, 'src/examples')
    }
  },
  server: {
    port: 3001,
    open: true,
    host: true
  },
  preview: {
    port: 4174,
    open: true
  },
  optimizeDeps: {
    include: []
  },
  define: {
    __DEV__: true
  },
  esbuild: {
    target: 'esnext',
    format: 'esm'
  }
});