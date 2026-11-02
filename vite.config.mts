import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ command }) => ({
  root: "src/renderer",
  base: "./",
  plugins: [
    react(),
    {
      // Vite's dev client needs a websocket; production CSP stays strict.
      name: "roam-dev-csp",
      transformIndexHtml(html) {
        return command === "serve" ? html.replace("connect-src 'self'", "connect-src 'self' ws://localhost:*") : html;
      },
    },
  ],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
    target: "chrome130",
    chunkSizeWarningLimit: 1500,
  },
  server: { port: 5173, strictPort: false },
}));
