// 集成入口：把当前需求分支变基到最新主分支，跑完整检查，再非强制地推送到主分支。
// 检查期间主分支前进时，推送会被拒；脚本随后重新变基、重新检查，不会拿旧结果推送。
// 检查输出原样打印，退出码非 0 就失败：不允许「检查没真正执行也报已集成」。
// 用法：在需求工作树里运行 node .inbox/scripts/integrate.mjs [--check "<命令>"]，默认用 inbox.config.json 的 commands.fullCheck。
// 退出码：0 成功；2 变基冲突（已中止变基）；1 其他失败。
import { spawnSync } from 'node:child_process'
import { argValue, checkoutRoot, isMain, readConfig } from './config.mjs'

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const out = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()

export function integrate({ cwd, check, remote = 'origin', mainBranch = 'main', maxAttempts = 3, stdio = 'inherit' }) {
  if (!check) return { ok: false, reason: 'no-check', detail: '没有检查命令：请在 inbox.config.json 填 commands.fullCheck，或用 --check 指定。' }
  const branch = git(cwd, 'symbolic-ref', '--short', '-q', 'HEAD').stdout.trim()
  if (!branch || branch === mainBranch) return { ok: false, reason: 'on-main', detail: `请在需求分支上运行，不要在 ${mainBranch} 或游离 HEAD 上。` }
  if (git(cwd, 'status', '--porcelain').stdout.trim()) return { ok: false, reason: 'dirty', detail: '工作树有未提交改动，先提交或清理。' }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const fetched = git(cwd, 'fetch', remote, mainBranch)
    if (fetched.status !== 0) return { ok: false, reason: 'fetch-failed', detail: out(fetched) }

    const rebase = git(cwd, 'rebase', `${remote}/${mainBranch}`)
    if (rebase.status !== 0) {
      const conflicts = git(cwd, 'diff', '--name-only', '--diff-filter=U').stdout.trim()
      git(cwd, 'rebase', '--abort')
      return { ok: false, reason: 'rebase-conflict', detail: conflicts || out(rebase) }
    }

    const checked = spawnSync('sh', ['-c', check], { cwd, encoding: 'utf8', stdio })
    if (checked.error) return { ok: false, reason: 'check-failed', detail: String(checked.error), attempts: attempt }
    if (checked.status !== 0) return { ok: false, reason: 'check-failed', detail: `检查命令退出码 ${checked.status}${stdio === 'inherit' ? '（输出见上方）' : `：${out(checked)}`}`, attempts: attempt }

    const pushed = git(cwd, 'push', remote, `HEAD:${mainBranch}`)
    if (pushed.status === 0) return { ok: true, attempts: attempt, head: git(cwd, 'rev-parse', 'HEAD').stdout.trim() }
    if (!/rejected|non-fast-forward|fetch first/.test(out(pushed))) return { ok: false, reason: 'push-failed', detail: out(pushed) }
  }
  return { ok: false, reason: 'main-moving', detail: `连续 ${maxAttempts} 次 ${mainBranch} 都在前进，稍后重试。` }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const root = checkoutRoot()
  const config = readConfig(root)
  const check = argValue(args, '--check') ?? config.commands.fullCheck
  console.log(`集成检查命令：${check}`)
  const result = integrate({ cwd: root, check, remote: config.remote, mainBranch: config.mainBranch, maxAttempts: Number(argValue(args, '--max-attempts') ?? 3) })
  if (result.ok) console.log(`已集成到 ${config.mainBranch}（第 ${result.attempts} 次尝试，检查命令退出码 0），提交 ${result.head}`)
  else console.error(`集成失败 [${result.reason}]：${result.detail}`)
  process.exit(result.ok ? 0 : result.reason === 'rebase-conflict' ? 2 : 1)
}
