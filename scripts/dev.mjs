// 本地预览 / 发布回退统一入口。
// 用 node 启动，避免 package.json 的 dev 脚本里出现 && / || 这类 shell 语法
// （WorkBuddy 本地预览启动器会拒绝含 shell 语法的脚本，报 SCRIPT_UNSUPPORTED）。
//
// 行为：
//  - 发布回退（平台注入非默认 PORT，或 NODE_ENV=production）→ 先构建再 preview（生产模式）
//  - 本地开发（dist 已存在）→ 直接 vite dev（带 HMR），且默认只监听 127.0.0.1
//  - 本地首次（无 dist）→ 先构建再 preview
// 会把 --host / --port 等参数透传给 vite。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const vite = 'node_modules/vite/bin/vite.js'
const PORT = process.env.PORT
const isProd =
  process.env.NODE_ENV === 'production' || (PORT != null && PORT !== '5173')
const hasDist = existsSync('dist/index.html')
const args = process.argv.slice(2)

function run(extra) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [vite, ...extra], {
      stdio: 'inherit',
      shell: false,
    })
    p.on('error', reject)
    p.on('exit', (code) => resolve(code ?? 0))
  })
}

if (isProd || !hasDist) {
  await run(['build'])
  await run(['preview', ...args])
} else {
  if (!args.includes('--host')) args.push('--host', '127.0.0.1')
  await run(args)
}
