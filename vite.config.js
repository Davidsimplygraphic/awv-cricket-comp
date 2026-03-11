import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: "./test/ui/setupTests.js",
    include: ["test/ui/**/*.test.{js,jsx}"],
  },
  server: {
    host: true,        // same as --host 0.0.0.0
    port: 5173,
    strictPort: true,
    hmr: {
      protocol: 'wss', // because trycloudflare is https
      clientPort: 443, // force HMR to connect over 443
    },
  },
})
