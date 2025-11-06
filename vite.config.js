import { defineConfig } from 'vite';

export default defineConfig({
    base: './', // Use relative paths for production
    server: {
        port: 3000, // Port for the development server
    },
    build: {
        outDir: 'dist', // Output directory for production build
        emptyOutDir: true, // Clear the output directory before building
    },
});