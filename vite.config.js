import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  optimizeDeps: {
    include: ['@tensorflow/tfjs', '@tensorflow-models/universal-sentence-encoder'],
  },
  server: {
    fs: {
      allow: ['..']
    }
  }
});
