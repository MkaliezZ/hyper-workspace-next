import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
function port(value: string | undefined, fallback: number) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535)
    throw new Error("Invalid development port");
  return parsed;
}
export default defineConfig({
  plugins: [react()],
  server: {
    port: port(process.env.WEB_PORT, 5173),
    strictPort: true,
    fs: {
      deny: [
        ".env",
        ".env.*",
        "*.{crt,pem}",
        "**/.git/**",
        "**/.runtime/**",
        "**/.data/**",
      ],
    },
    proxy: {
      "/api": {
        target: "http://127.0.0.1:" + port(process.env.API_PORT, 3100),
        changeOrigin: true,
        configure(proxy) {
          proxy.on("error", (_error, _req, res) => {
            if ("writeHead" in res && !res.headersSent && !res.writableEnded)
              res
                .writeHead(503, {
                  "Content-Type": "application/json; charset=utf-8",
                  "Cache-Control": "no-store",
                })
                .end(
                  JSON.stringify({
                    message:
                      "服务正在重连，请稍后重试；已提交操作请先核对原回执。",
                  }),
                );
          });
        },
      },
    },
  },
});
