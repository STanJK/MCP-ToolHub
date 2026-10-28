import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
