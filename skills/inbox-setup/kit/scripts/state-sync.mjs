// 状态同步：把主检出里「想法簿」和「发现账本」的未提交改动，只限这两个文件地提交并推送到主分支。
// 发现需求开始时调用一次，让负责人白天写下的想法和否决记录进入远端，其他会话和工作树都看得到。
// 任何失败都只汇报、不抛错、不中断发现；提交留在本地，下次再试。负责人的其他未提交文件一律不碰。
// 用法：node .inbox/scripts/state-sync.mjs [--root <主检出路径>]
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { argValue, isMain, normalize, paths } from './config.mjs'

export const syncFiles = [paths.ideas, paths.ledger]

const run = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const text = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
const lines = (result) => (result.stdout ?? '').split('\n').filter(Boolean)
// 中文文件名在非 -z 输出里会被转义成八进制，凡是要和文件名比较的地方都用 -z。
const nulLines = (result) => (result.stdout ?? '').split('\0').filter(Boolean)

// 主检出是 worktree 列表的第一项；在需求工作树里调用时也写回主检出。
export function mainCheckout(cwd) {
  const first = lines(run(cwd, 'worktree', 'list', '--porcelain')).find((line) => line.startsWith('worktree '))
  return first ? first.slice('worktree '.length) : cwd
}

function inProgress(root) {
  return ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((name) => existsSync(path.resolve(root, run(root, 'rev-parse', '--git-path', name).stdout.trim())))
}

function otherDirty(root) {
  const entries = nulLines(run(root, 'status', '--porcelain', '-z', '--untracked-files=all'))
  const files = []
  for (let i = 0; i < entries.length; i++) {
    files.push(entries[i].slice(3))
    if (/^[RC]/.test(entries[i])) files.push(entries[++i])
  }
  return files.filter((file) => !syncFiles.includes(file))
}

const dirtyOf = (root, file) => text(run(root, 'status', '--porcelain', '--', file)) !== ''

export function stateSync({ root, remote = 'origin', mainBranch = 'main' }) {
  const report = []
  const say = (message) => report.push(message)
  const branch = run(root, 'symbolic-ref', '--short', '-q', 'HEAD').stdout.trim()
  if (branch !== mainBranch) return [`状态同步已跳过：主检出当前不在 ${mainBranch}（在「${branch || '游离 HEAD'}」）。`]
  if (inProgress(root)) return ['状态同步已跳过：主检出正处于变基或合并中。']

  const fetched = run(root, 'fetch', remote, mainBranch)
  if (fetched.status !== 0) say(`状态同步：拉取 ${remote} 失败，只在本地提交：${text(fetched)}`)
  const target = `${remote}/${mainBranch}`

  const ready = syncFiles.filter((file) => dirtyOf(root, file))
  if (ready.length) {
    // 路径限定提交：不带走暂存区或工作区里的其他文件。未跟踪的文件先登记路径才能被 --only 选中。
    const added = run(root, 'add', '--', ...ready)
    const message = `docs: 同步${ready.map((file) => (file === paths.ideas ? '想法簿' : '发现账本')).join('与')}`
    const committed = added.status === 0 ? run(root, 'commit', '-m', message, '--only', '--', ...ready) : added
    if (committed.status !== 0) return [...report, `状态同步：提交失败：${text(committed)}`]
    say(`状态同步：已提交 ${ready.join('、')}。`)
  }

  if (run(root, 'rev-parse', '--verify', '-q', target).status !== 0) return report
  const ahead = nulLines(run(root, 'diff', '--name-only', '-z', `${target}...HEAD`))
  if (!ahead.length) {
    if (!ready.length) say('状态同步：想法簿和发现账本没有改动。')
    return report
  }
  // 只推送「仅含这两个文件」的本地领先提交；混进别的文件说明不是本脚本造的，不替它推送。
  const foreign = ahead.filter((file) => !syncFiles.includes(file))
  if (foreign.length) return [...report, `状态同步：本地 ${mainBranch} 领先 ${target} 的提交含有这两个文件之外的改动（${foreign.join('、')}），不推送。`]

  let pushed = run(root, 'push', remote, `HEAD:${mainBranch}`)
  if (pushed.status !== 0 && /rejected|non-fast-forward|fetch first/.test(text(pushed))) {
    run(root, 'fetch', remote, mainBranch)
    const incoming = nulLines(run(root, 'diff', '--name-only', '-z', `HEAD...${target}`))
    const clash = incoming.filter((file) => otherDirty(root).includes(file))
    if (clash.length) return [...report, `状态同步：远端改了你正在编辑的 ${clash.join('、')}，本次不推送；提交留在本地。`]
    const rebased = run(root, '-c', 'rebase.autoStash=true', 'rebase', target)
    if (rebased.status !== 0) {
      run(root, 'rebase', '--abort')
      return [...report, `状态同步：变基到 ${target} 冲突，已放弃，提交留在本地：${text(rebased)}`]
    }
    pushed = run(root, 'push', remote, `HEAD:${mainBranch}`)
  }
  if (pushed.status !== 0) return [...report, `状态同步：推送失败，提交留在本地：${text(pushed)}`]
  say(`状态同步：已推送到 ${mainBranch}。`)
  return report
}

if (isMain(import.meta.url)) {
  const root = argValue(process.argv.slice(2), '--root') ?? mainCheckout(process.cwd())
  const file = path.join(root, 'inbox.config.json')
  const { config } = normalize(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
  console.log(stateSync({ root, remote: config.remote, mainBranch: config.mainBranch }).join('\n'))
}
