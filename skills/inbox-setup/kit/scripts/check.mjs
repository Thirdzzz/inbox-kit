// 收件箱总检查：配置有效、依赖无误、记录状态合规、需求分支没越权。
// 用法（主检出，调度者合并前）：node .inbox/scripts/check.mjs <NNN>   用主检出的脚本和记录检查该需求的工作树
// 用法（子代理在自己的工作树里、或 CI）：node .inbox/scripts/check.mjs   检查当前检出
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkoutRoot, mainRoot, readConfig } from './config.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const [id] = process.argv.slice(2)
let failed = false
try {
  readConfig(id ? mainRoot() : checkoutRoot())
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
for (const [script, args] of [['check-ownership.mjs', id ? [id] : []], ['dependencies.mjs', []], ['check-status.mjs', []]]) {
  const result = spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    failed = true
    process.stderr.write(`✗ ${script}\n${result.stderr}${result.stdout}`)
  } else console.log(`✓ ${script}`)
}
process.exit(failed ? 1 : 0)
