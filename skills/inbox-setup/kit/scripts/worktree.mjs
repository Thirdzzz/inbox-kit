// 需求工作树的认领与清理。认领 = 成功执行 git worktree add；路径已存在或分支已在别处检出时 git 会拒绝，
// 所以同一需求只有一个会话能认领成功。
// 用法（主检出）：
//   node .inbox/scripts/worktree.mjs claim <NNN>       新建或接管 <worktreeDir>/NNN（分支 inbox/NNN），输出 JSON
//   node .inbox/scripts/worktree.mjs cleanup <NNN> [--keep-branch]   删除工作树；默认连本地与远端分支一起删
//   node .inbox/scripts/worktree.mjs list              列出所有需求工作树
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { isMain, mainRoot, readConfig, worktreeBase, worktreePath } from './config.mjs'
import { killGroup, parseAgentId } from './process.mjs'

const run = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const ok = (result) => result.status === 0
const text = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()

export class ClaimedElsewhere extends Error {}

export function claim(root, config, id) {
  if (!/^\d{3}$/.test(id ?? '')) throw new Error(`编号无效：${id}`)
  const { remote, mainBranch } = config
  const dir = worktreePath(root, config, id)
  const branch = `inbox/${id}`
  if (existsSync(path.join(dir, '.git'))) return { id, path: dir, branch, adopted: true, created: false }
  if (existsSync(dir)) throw new Error(`${dir} 存在但不是工作树（残缺）。运行 node .inbox/scripts/worktree.mjs cleanup ${id} --keep-branch 后再认领。`)
  mkdirSync(path.dirname(dir), { recursive: true })
  // 清掉指向已删除目录的旧登记，否则 git 会以「分支已在别处检出」拒绝。
  run(root, 'worktree', 'prune')
  const fetched = run(root, 'fetch', remote, mainBranch)
  if (!ok(fetched)) throw new Error(`拉取 ${remote}/${mainBranch} 失败，无法认领：${text(fetched)}`)
  run(root, 'fetch', remote, `+${branch}:refs/remotes/${remote}/${branch}`)
  const local = ok(run(root, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`))
  const pushed = ok(run(root, 'rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`))
  let added
  if (local) added = run(root, 'worktree', 'add', dir, branch)
  else if (pushed) added = run(root, 'worktree', 'add', '-b', branch, dir, `${remote}/${branch}`)
  else added = run(root, 'worktree', 'add', '-b', branch, dir, `${remote}/${mainBranch}`)
  if (!ok(added)) {
    const detail = text(added)
    if (/already (checked out|used by worktree)|already exists/.test(detail)) throw new ClaimedElsewhere(`${id} 已被其他会话认领：${detail}`)
    throw new Error(`认领 ${id} 失败：${detail}`)
  }
  return { id, path: dir, branch, adopted: local || pushed, created: true }
}

export function cleanup(root, config, id, { keepBranch = false } = {}) {
  const dir = worktreePath(root, config, id)
  const branch = `inbox/${id}`
  const report = []
  if (existsSync(dir)) {
    // 回收子代理留下的后台进程（开发服务器、监听进程），它们和子代理同属一个进程组。
    const gitDir = run(dir, 'rev-parse', '--path-format=absolute', '--git-dir').stdout.trim()
    const idFile = gitDir && path.join(gitDir, 'inbox-agent-id')
    if (idFile && existsSync(idFile)) {
      const { pid } = parseAgentId(readFileSync(idFile, 'utf8').trim())
      if (pid && killGroup(pid)) report.push(`已停止进程组 ${pid}`)
    }
    if (!ok(run(root, 'worktree', 'remove', '--force', dir))) rmSync(dir, { recursive: true, force: true })
    report.push(`已删除工作树 ${dir}`)
  }
  run(root, 'worktree', 'prune')
  if (!keepBranch) {
    if (ok(run(root, 'branch', '-D', branch))) report.push(`已删除本地分支 ${branch}`)
    const remoteDelete = run(root, 'push', config.remote, '--delete', branch)
    if (ok(remoteDelete)) report.push(`已删除远端分支 ${branch}`)
    else if (!/remote ref does not exist|not found|unable to delete/i.test(text(remoteDelete))) report.push(`远端分支 ${branch} 删除失败：${text(remoteDelete)}`)
  }
  return report
}

export function list(root, config) {
  const base = worktreeBase(root, config)
  if (!existsSync(base)) return []
  return readdirSync(base).filter((name) => /^\d{3}$/.test(name)).map((id) => {
    const dir = path.join(base, id)
    const head = run(dir, 'rev-parse', 'HEAD').stdout.trim()
    const pushed = Boolean(head) && ok(run(root, 'merge-base', '--is-ancestor', head, `${config.remote}/inbox/${id}`))
    const dirty = run(dir, 'status', '--porcelain').stdout.trim() !== ''
    return { id, path: dir, head, pushed, dirty }
  })
}

if (isMain(import.meta.url)) {
  const [command, id, ...rest] = process.argv.slice(2)
  try {
    const root = mainRoot()
    const config = readConfig(root)
    if (command === 'claim') console.log(JSON.stringify(claim(root, config, id), null, 2))
    else if (command === 'cleanup') console.log(cleanup(root, config, id, { keepBranch: rest.includes('--keep-branch') }).join('\n') || '没有需要清理的内容')
    else if (command === 'list') console.log(JSON.stringify(list(root, config), null, 2))
    else {
      console.error('用法：worktree.mjs claim <NNN> | cleanup <NNN> [--keep-branch] | list')
      process.exitCode = 2
    }
  } catch (error) {
    console.error(error.message)
    // 退出码 3：已被其他会话认领，调度者跳过即可；1：其他错误，要处理。
    process.exitCode = error instanceof ClaimedElsewhere ? 3 : 1
  }
}
