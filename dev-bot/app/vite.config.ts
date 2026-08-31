import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // GitHub Pages 는 저장소 이름이 붙은 하위 경로로 서비스된다.
  // './' 로 두면 배포 주소 아래에서도 자산을 상대 경로로 찾는다.
  base: "./",
  plugins: [react()],
  build: { outDir: "dist" },
  // onnxruntime-web 의 wasm 은 미리 번들하지 않는다
  optimizeDeps: { exclude: ["onnxruntime-web"] },
});
