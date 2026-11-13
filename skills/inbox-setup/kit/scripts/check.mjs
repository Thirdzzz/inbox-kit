// 收件箱的总检查：配置有效、依赖无误、记录状态合规、需求分支没越权写调度者的文件。
// 子代理交付前、集成前都要跑；建议把它接进项目自己的 lint 或 CI。
// 用法：node .inbox/scripts/check.mjs
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkoutRoot, readConfig } from './config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
let failed = false
try {
  readConfig(checkoutRoot())
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
for (const script of ['check-ownership.mjs', 'dependencies.mjs', 'check-status.mjs']) {
  const result = spawnSync(process.execPath, [path.join(here, script)], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed = true
    process.stderr.write(`✗ ${script}\n${result.stderr}${result.stdout}`)
  } else console.log(`✓ ${script}`)
}
process.exit(failed ? 1 : 0)
