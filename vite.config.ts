import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths'

const API_TARGET = process.env.VITE_API_TARGET || 'http://localhost:3001'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tsconfigPaths()],
  server: {
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: true,
        secure: false,
      },
      // Socket.IO 需要 WebSocket 代理，否则前端拿不到 trafficLightUpdate 等实时推送，
      // 红绿灯倒计时只能依赖 HTTP 拉取（刷新页面才更新）。
      '/socket.io': {
        target: API_TARGET,
        changeOrigin: true,
        ws: true,
        secure: false,
      },
    },
  },
})
