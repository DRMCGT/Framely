import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  base: '/',
  publicDir: 'public',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        studio: resolve(__dirname, 'src/page/studio.html'),
        background: resolve(__dirname, 'src/background.js')
      },
      output: {
        entryFileNames: (chunk) => {
          // keep background as service worker at predictable path
          if (chunk.name === 'background') return 'src/background.js';
          return 'assets/[name]-[hash].js';
        }
      }
    }
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: 'vendor/ffmpeg/*', dest: 'vendor/ffmpeg' },
        { src: 'node_modules/@ffmpeg/ffmpeg/dist/esm/worker.js', dest: 'vendor/ffmpeg', rename: 'worker.js' },
        { src: 'node_modules/@ffmpeg/ffmpeg/dist/esm/const.js', dest: 'vendor/ffmpeg' },
        { src: 'node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js', dest: 'vendor/ffmpeg' },
        { src: 'icons/*', dest: 'icons' },
        { src: 'manifest.json', dest: '.' },
        { src: 'src/content/*', dest: 'src/content' }
      ]
    })
  ]
});
