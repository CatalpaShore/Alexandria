import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react(), {
    name: "main-product-scope",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (/^\/(?:web-library|api\/web-library)(?:\/|\?|$)/.test(req.url ?? "")) {
          res.statusCode = 404;
          res.end("Not Found");
          return;
        }
        next();
      });
    }
  }],
  root: "client",
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          if (id.includes("node_modules/@tanstack/")) return "vendor-query";
          if (id.includes("node_modules/lucide-react/")) return "vendor-icons";
          if (id.includes("node_modules/hls.js/")) return "vendor-hls";
          if (/node_modules\/(antd|@ant-design)\//.test(id)) return "vendor-antd";
          return undefined;
        }
      }
    }
  },
  server: {
    host: (process.env.AMW_LAN_MODE ?? "false").trim().toLowerCase() === "true" ? "0.0.0.0" : "127.0.0.1",
    port: 4311,
    strictPort: true,
    proxy: {
      "/api": {
        target: process.env.VITE_API_TARGET ?? "http://127.0.0.1:4310",
        // The API validates browser write origins. Preserve the public Vite
        // host instead of replacing it with the internal API host/port.
        changeOrigin: false,
        xfwd: true
      }
    }
  }
});
