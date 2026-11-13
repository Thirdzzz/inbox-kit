// 回收：按需求记录的状态，删掉已经没用的工作树、本地分支和远端分支，让它们不随需求增多而堆积。
// 规则（以主检出里的 inbox/NNN-*.md 为准）：
//   进行中、子代理还活着，或（非终态时）5 分钟内刚认领且还没启动子代理 → 不动
//   已上线、已否决                  → 工作树、本地分支、远端分支全删（代码已在主分支上，或已被否决）
//   待办、待检查、需要补充、失败    → 远端分支保留（重试、合并、负责人审阅都要用它）；
//                                     工作树和本地分支在「干净且每个提交都已在远端分支或主分支上」时删掉，下次认领会从远端接管；
//                                     有未推送的改动就保留并说明（重派时会直接接管这个工作树，不会越积越多）
//   没有记录的 inbox/NNN            → 提交全在主分支上就删，否则保留并报告
//   rollback-NNN 工作树与 rollback/NNN 分支 → 回滚已落到主分支就删
// 用法（主检出）：
//   node .inbox/scripts/gc.mjs           执行回收，输出 JSON {removed, kept}
//   node .inbox/scripts/gc.mjs --check   只检查：还有该删没删的，或需要人处理的残留，退出码 1
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, rmdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { isMain, mainRoot, readConfig, worktreeBase, worktreePath } from './config.mjs'
import { isOurProcess } from './process.mjs'
import { launchWindowMinutes, recordStatuses } from './watchdog.mjs'
import { cleanup } from './worktree.mjs'

const run = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const ok = (result) => result.status === 0
const refExists = (root, ref) => ok(run(root, 'rev-parse', '--verify', '-q', ref))
const terminal = new Set(['已上线', '已否决'])

// head 上哪些提交在 upstream 里找不到等价补丁（变基后提交号会变，所以按补丁比较）。上游不存在时返回 null。
function uniqueCommits(cwd, upstream, head) {
  const result = run(cwd, 'cherry', upstream, head)
  if (!ok(result)) return null
  return new Set(result.stdout.split('\n').filter((line) => line.startsWith('+ ')).map((line) => line.slice(2)))
}

// 只在 head 上、既不在远端分支也不在主分支上的提交。
function unpushed(cwd, head, refs) {
  let remaining = null
  for (const ref of refs) {
    const unique = uniqueCommits(cwd, ref, head)
    if (!unique) continue
    remaining = remaining ? new Set([...remaining].filter((sha) => unique.has(sha))) : unique
  }
  return remaining ? [...remaining] : ['（找不到可比较的远端分支）']
}

function agentAlive(dir) {
  const gitDir = run(dir, 'rev-parse', '--path-format=absolute', '--git-dir').stdout.trim()
  const idFile = gitDir && path.join(gitDir, 'inbox-agent-id')
  return Boolean(idFile && existsSync(idFile) && isOurProcess(readFileSync(idFile, 'utf8').trim()))
}

// 刚认领、还没启动过子代理的工作树（启动窗口内）不回收：调度者可能正要把它改成「进行中」再启动。
// 只看「还没启动过」：子代理跑完很快时，收尾回收不能被这个窗口挡住。
function justClaimed(dir, now = Date.now()) {
  try {
    const gitDir = run(dir, 'rev-parse', '--path-format=absolute', '--git-dir').stdout.trim()
    if (!gitDir || existsSync(path.join(gitDir, 'inbox-agent-id'))) return false
    return now - statSync(path.join(dir, '.git')).mtimeMs < launchWindowMinutes * 60000
  } catch {
    return false
  }
}

const branchesMatching = (root, pattern, regex) =>
  run(root, 'for-each-ref', '--format=%(refname:lstrip=2)', pattern).stdout.split('\n').map((ref) => regex.exec(ref)?.[1]).filter(Boolean)

export function collectGarbage(root, config, { dryRun = false } = {}) {
  const { remote, mainBranch } = config
  const mainRef = `${remote}/${mainBranch}`
  const removed = []
  const kept = []
  run(root, 'fetch', '--prune', remote)
  run(root, 'worktree', 'prune')
  const base = worktreeBase(root, config)
  const dirs = existsSync(base) ? readdirSync(base) : []
  const statuses = recordStatuses(root)
  const ids = new Set([
    ...dirs.filter((name) => /^\d{3}$/.test(name)),
    ...branchesMatching(root, 'refs/heads/inbox/', /^inbox\/(\d{3})$/),
    ...branchesMatching(root, `refs/remotes/${remote}/inbox/`, new RegExp(`^${remote}/inbox/(\\d{3})$`)),
  ])

  for (const id of [...ids].sort()) {
    const status = statuses.get(id)
    const dir = worktreePath(root, config, id)
    const hasWorktree = existsSync(dir)
    const local = `refs/heads/inbox/${id}`
    const pushed = `refs/remotes/${remote}/inbox/${id}`
    if (status === '进行中' || (hasWorktree && agentAlive(dir))) continue
    if (hasWorktree && !terminal.has(status) && justClaimed(dir)) {
      kept.push({ id, status, reason: '刚认领、还没启动子代理（5 分钟内），暂不回收' })
      continue
    }

    let full = terminal.has(status)
    if (!status) {
      const head = hasWorktree ? 'HEAD' : refExists(root, local) ? local : pushed
      const left = unpushed(hasWorktree ? dir : root, head, [mainRef])
      if (left.length) {
        kept.push({ id, reason: `没有需求记录，分支上还有 ${left.length} 个未合入主分支的提交；确认无用后运行 node .inbox/scripts/worktree.mjs cleanup ${id}`, attention: true })
        continue
      }
      full = true
    }
    if (full) {
      const what = [hasWorktree && '工作树', refExists(root, local) && '本地分支', refExists(root, pushed) && '远端分支'].filter(Boolean)
      if (!what.length) continue
      if (!dryRun) cleanup(root, config, id)
      removed.push({ id, status: status ?? '无记录', removed: what })
      continue
    }

    // 待办、待检查、需要补充、失败：保留远端分支，回收本机的工作树和本地分支。
    const remoteRefs = [pushed, mainRef].filter((ref) => refExists(root, ref))
    if (hasWorktree) {
      const dirty = run(dir, 'status', '--porcelain').stdout.trim() !== ''
      const left = dirty ? [] : unpushed(dir, 'HEAD', remoteRefs)
      if (dirty || left.length) {
        kept.push({ id, status, reason: dirty ? '工作树有未提交的改动，重派时会直接接管' : `有 ${left.length} 个提交未推送，重派时会直接接管` })
        continue
      }
      if (!dryRun) cleanup(root, config, id, { keepBranch: true })
    } else if (refExists(root, local)) {
      if (unpushed(root, local, remoteRefs).length) {
        kept.push({ id, status, reason: '本地分支有未推送的提交，重派时会直接接管' })
        continue
      }
    } else continue
    if (!dryRun) run(root, 'branch', '-D', `inbox/${id}`)
    removed.push({ id, status, removed: [hasWorktree && '工作树', '本地分支'].filter(Boolean) })
  }

  // 回滚用的临时工作树与分支：回滚提交落到主分支后删除。
  const rollbacks = new Set([
    ...dirs.map((name) => /^rollback-(\d{3})$/.exec(name)?.[1]).filter(Boolean),
    ...branchesMatching(root, 'refs/heads/rollback/', /^rollback\/(\d{3})$/),
    ...branchesMatching(root, `refs/remotes/${remote}/rollback/`, new RegExp(`^${remote}/rollback/(\\d{3})$`)),
  ])
  for (const id of rollbacks) {
    const dir = path.join(base, `rollback-${id}`)
    // 刚建的回滚工作树还没有回滚提交，看起来「已全部在主分支上」，启动窗口内不能删。
    if (existsSync(dir) && justClaimed(dir)) continue
    const head = existsSync(dir) ? 'HEAD' : refExists(root, `refs/heads/rollback/${id}`) ? `rollback/${id}` : `${remote}/rollback/${id}`
    const left = unpushed(existsSync(dir) ? dir : root, head, [mainRef])
    if (left.length) {
      kept.push({ id: `rollback-${id}`, reason: `回滚还没落到 ${mainBranch}（${left.length} 个提交），落地后会自动删除` })
      continue
    }
    if (!dryRun) {
      if (existsSync(dir)) run(root, 'worktree', 'remove', '--force', dir)
      run(root, 'branch', '-D', `rollback/${id}`)
      run(root, 'push', remote, '--delete', `rollback/${id}`)
    }
    removed.push({ id: `rollback-${id}`, removed: ['回滚工作树或分支'] })
  }

  if (!dryRun) {
    run(root, 'worktree', 'prune')
    if (existsSync(base) && readdirSync(base).length === 0) rmdirSync(base)
  }
  return { removed, kept }
}

if (isMain(import.meta.url)) {
  const check = process.argv.includes('--check')
  try {
    const root = mainRoot()
    const result = collectGarbage(root, readConfig(root), { dryRun: check })
    console.log(JSON.stringify(result, null, 2))
    if (check) {
      const problems = [...result.removed.map((r) => `${r.id}（${r.status}）的${r.removed.join('、')}已经没用，运行 node .inbox/scripts/gc.mjs 删除`), ...result.kept.filter((k) => k.attention).map((k) => `${k.id}：${k.reason}`)]
      for (const line of problems) console.error(line)
      process.exitCode = problems.length ? 1 : 0
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
