import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 4000, // the AnyChart bundle alone is about 3.7 MB
    rollupOptions: { output: { manualChunks: { anychart: ['anychart'], 'ag-grid': ['ag-grid-community', 'ag-grid-react'] } } },
  },
});
