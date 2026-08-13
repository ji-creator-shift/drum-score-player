import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// https://vite.dev/config/
export default defineConfig({
  // 相对路径，确保 Electron file:// 协议下资源能正确加载
  base: './',
  plugins: [vue()],
})
