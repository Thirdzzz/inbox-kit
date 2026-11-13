// 集成：把需求分支变基到最新主分支，跑完整检查，再非强制地推送到主分支。
// 检查命令、越权规则都取自主检出（主分支上的 inbox.config.json 和 .inbox/scripts），不取需求分支里的副本：
// 否则子代理改一下分支里的配置，就能把自己的合并门禁改成 true。
// 检查期间主分支前进时推送会被拒；脚本随后重新变基、重新检查，不会拿旧结果推送。
// 用法（主检出）：node .inbox/scripts/integrate.mjs <NNN>            集成需求 NNN 的工作树
// 用法（维护分支的工作树里）：node .inbox/scripts/integrate.mjs      集成当前分支（改流水线自身时用）
// 可选：--check "<命令>" 覆盖检查命令；--max-attempts N。
// 退出码：0 成功；2 变基冲突（已中止变基）；1 其他失败。
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { argValue, checkoutRoot, isMain, mainRoot, readConfig, worktreePath } from './config.mjs'
import { checkBranch } from './check-ownership.mjs'

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const out = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()

// guard：每次变基后、检查前调用，返回 { ok, message }；用于在主检出的规则下复查越权。
export function integrate({ cwd, check, remote = 'origin', mainBranch = 'main', maxAttempts = 3, stdio = 'inherit', guard = () => ({ ok: true }) }) {
  if (!check) return { ok: false, reason: 'no-check', detail: '没有检查命令：请在 inbox.config.json 填 commands.fullCheck，或用 --check 指定。' }
  const branch = git(cwd, 'symbolic-ref', '--short', '-q', 'HEAD').stdout.trim()
  if (!branch || branch === mainBranch) return { ok: false, reason: 'on-main', detail: `请指定需求编号（node .inbox/scripts/integrate.mjs <NNN>），或在维护分支的工作树里运行；不要在 ${mainBranch} 或游离 HEAD 上集成。` }
  if (git(cwd, 'status', '--porcelain').stdout.trim()) return { ok: false, reason: 'dirty', detail: `${cwd} 有未提交改动，先提交或清理。` }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const fetched = git(cwd, 'fetch', remote, mainBranch)
    if (fetched.status !== 0) return { ok: false, reason: 'fetch-failed', detail: out(fetched) }

    const rebase = git(cwd, 'rebase', `${remote}/${mainBranch}`)
    if (rebase.status !== 0) {
      const conflicts = git(cwd, 'diff', '--name-only', '--diff-filter=U').stdout.trim()
      git(cwd, 'rebase', '--abort')
      return { ok: false, reason: 'rebase-conflict', detail: conflicts || out(rebase) }
    }

    const guarded = guard()
    if (!guarded.ok) return { ok: false, reason: 'ownership', detail: guarded.message }

    const checked = spawnSync('sh', ['-c', check], { cwd, encoding: 'utf8', stdio })
    if (checked.error) return { ok: false, reason: 'check-failed', detail: String(checked.error), attempts: attempt }
    if (checked.status !== 0) return { ok: false, reason: 'check-failed', detail: `检查命令退出码 ${checked.status}${stdio === 'inherit' ? '（输出见上方）' : `：${out(checked)}`}`, attempts: attempt }

    const pushed = git(cwd, 'push', remote, `HEAD:${mainBranch}`)
    if (pushed.status === 0) return { ok: true, attempts: attempt, head: git(cwd, 'rev-parse', 'HEAD').stdout.trim() }
    // 只有「主分支前进了」才重试；受保护分支、服务端钩子的拒绝（remote rejected）直接失败。
    if (!/non-fast-forward|fetch first/.test(out(pushed))) return { ok: false, reason: 'push-failed', detail: out(pushed) }
  }
  return { ok: false, reason: 'main-moving', detail: `连续 ${maxAttempts} 次 ${mainBranch} 都在前进，稍后重试。` }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const id = args.find((arg) => /^\d{3}$/.test(arg))
  try {
    const root = id ? mainRoot() : checkoutRoot()
    // 指定需求时，检查命令和规则一律来自主检出；在维护分支里自集成时，来自该分支（它本来就是在改流水线）。
    const config = readConfig(id ? mainRoot() : root)
    const cwd = id ? worktreePath(root, config, id) : root
    if (id && !path.isAbsolute(cwd)) throw new Error(`工作树路径无效：${cwd}`)
    const check = argValue(args, '--check') ?? config.commands.fullCheck
    console.log(`集成检查命令：${check}${id ? `（取自主检出的 inbox.config.json）` : ''}`)
    const guard = id ? () => checkBranch({ cwd, recordsRoot: root, config }) : () => ({ ok: true })
    const result = integrate({ cwd, check, remote: config.remote, mainBranch: config.mainBranch, maxAttempts: Number(argValue(args, '--max-attempts') ?? 3), guard })
    if (result.ok) console.log(`已集成到 ${config.mainBranch}（第 ${result.attempts} 次尝试，检查命令退出码 0），提交 ${result.head}`)
    else console.error(`集成失败 [${result.reason}]：${result.detail}`)
    process.exit(result.ok ? 0 : result.reason === 'rebase-conflict' ? 2 : 1)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
