import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          "three-examples": [
            "three/examples/jsm/controls/OrbitControls.js",
            "three/examples/jsm/loaders/GLTFLoader.js",
            "three/examples/jsm/postprocessing/EffectComposer.js",
            "three/examples/jsm/postprocessing/RenderPass.js",
            "three/examples/jsm/postprocessing/UnrealBloomPass.js",
          ],
          react: ["react", "react-dom"],
          vendor: ["lucide-react"],
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
});