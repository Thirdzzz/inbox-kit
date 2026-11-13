// 需求工作树的认领与清理。认领 = 成功执行 git worktree add；路径已存在或分支已在别处检出时 git 会拒绝，
// 所以同一需求只有一个会话能认领成功。
// 用法：
//   node .inbox/scripts/worktree.mjs claim <NNN>     新建或接管 <worktreeDir>/NNN（分支 inbox/NNN），输出 JSON
//   node .inbox/scripts/worktree.mjs cleanup <NNN> [--keep-branch]   删除工作树；默认连本地与远端分支一起删
//   node .inbox/scripts/worktree.mjs list            列出所有需求工作树及其分支是否已推送
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { isMain, mainRoot, readConfig } from './config.mjs'

const run = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
const ok = (result) => result.status === 0
const text = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()

export function claim(root, id, { worktreeDir, remote, mainBranch }) {
  if (!/^\d{3}$/.test(id)) throw new Error(`编号无效：${id}`)
  const dir = path.join(root, worktreeDir, id)
  const branch = `inbox/${id}`
  if (existsSync(dir)) return { id, path: dir, branch, adopted: true, created: false }
  mkdirSync(path.dirname(dir), { recursive: true })
  run(root, 'fetch', remote, mainBranch)
  run(root, 'fetch', remote, `${branch}:refs/remotes/${remote}/${branch}`)
  const local = ok(run(root, 'rev-parse', '--verify', '-q', `refs/heads/${branch}`))
  const pushed = ok(run(root, 'rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`))
  let added
  if (local) added = run(root, 'worktree', 'add', dir, branch)
  else if (pushed) added = run(root, 'worktree', 'add', '-b', branch, dir, `${remote}/${branch}`)
  else added = run(root, 'worktree', 'add', '-b', branch, dir, `${remote}/${mainBranch}`)
  if (!ok(added)) throw new Error(`认领 ${id} 失败（可能已被其他会话认领）：${text(added)}`)
  return { id, path: dir, branch, adopted: local || pushed, created: true }
}

export function cleanup(root, id, { worktreeDir, remote, keepBranch = false }) {
  const dir = path.join(root, worktreeDir, id)
  const branch = `inbox/${id}`
  const report = []
  if (existsSync(dir)) {
    const removed = run(root, 'worktree', 'remove', '--force', dir)
    if (!ok(removed)) rmSync(dir, { recursive: true, force: true })
    report.push(`已删除工作树 ${dir}`)
  }
  run(root, 'worktree', 'prune')
  if (!keepBranch) {
    if (ok(run(root, 'branch', '-D', branch))) report.push(`已删除本地分支 ${branch}`)
    const remoteDelete = run(root, 'push', remote, '--delete', branch)
    if (ok(remoteDelete)) report.push(`已删除远端分支 ${branch}`)
    else if (!/remote ref does not exist|not found|unable to delete/.test(text(remoteDelete))) report.push(`远端分支 ${branch} 删除失败：${text(remoteDelete)}`)
  }
  return report
}

export function list(root, { worktreeDir, remote }) {
  const base = path.join(root, worktreeDir)
  if (!existsSync(base)) return []
  run(root, 'fetch', remote)
  return spawnSync('ls', [base], { encoding: 'utf8' }).stdout.split('\n').filter((name) => /^\d{3}$/.test(name)).map((id) => {
    const dir = path.join(base, id)
    const head = run(dir, 'rev-parse', 'HEAD').stdout.trim()
    const pushed = ok(run(root, 'merge-base', '--is-ancestor', head, `${remote}/inbox/${id}`))
    const dirty = run(dir, 'status', '--porcelain').stdout.trim() !== ''
    return { id, path: dir, head, pushed, dirty }
  })
}

if (isMain(import.meta.url)) {
  const [command, id, ...rest] = process.argv.slice(2)
  try {
    const root = mainRoot()
    const config = readConfig(root)
    if (command === 'claim') console.log(JSON.stringify(claim(root, id, config), null, 2))
    else if (command === 'cleanup') console.log(cleanup(root, id, { ...config, keepBranch: rest.includes('--keep-branch') }).join('\n') || '没有需要清理的内容')
    else if (command === 'list') console.log(JSON.stringify(list(root, config), null, 2))
    else {
      console.error('用法：worktree.mjs claim <NNN> | cleanup <NNN> [--keep-branch] | list')
      process.exitCode = 2
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
