import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 线上发布时平台会注入 PORT（本地开发不给 → 用 5173）。
// 端口写死会导致发布后服务监听错端口、反代连不上，所以两边都读 env。
// 这里不走 `process` 全局类型 —— 项目没装 @types/node，直接取会 tsc 报 TS2580。
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
const port = Number(env?.PORT) || 5173

export default defineConfig({
  // 打包后资源用相对路径（dist/index.html 引用 ./assets/...，可放任意子目录/直接打开）
  base: './',
  plugins: [react()],
  // 本地开发只绑 127.0.0.1（开发预览只在本机/面板访问，不对外暴露）。
  // 线上发布走 preview，preview.host 仍是 true（绑 0.0.0.0）保证外网可访问。
  // allowedHosts: true → Vite 5.4.12+ 默认会拦掉非本机的 Host 头，
  //   发布后访问域名会直接 403 "Blocked request. This host is not allowed."，必须放开
  server: { host: '127.0.0.1', port, allowedHosts: true },
  preview: { host: true, port, allowedHosts: true },
})
