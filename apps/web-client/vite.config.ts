import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Optional WS proxy — forwards WebSocket connections to the gateway.
      // When using this, you can change VITE_WS_URL to ws://localhost:5173/ws-proxy
      // and add Authorization header here. Currently unused (client sends ?token= instead).
      "/ws-proxy": {
        target: "ws://localhost:3001",
        ws: true,
        rewrite: (path) => path.replace(/^\/ws-proxy/, "/ws"),
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
