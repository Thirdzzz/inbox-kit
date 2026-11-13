// 状态同步：把主检出里收件箱状态文件的改动，只限这些文件地提交、变基到最新主分支并推送；最后让主检出跟上远端。
// 为什么：需求代码由 integrate.mjs 从工作树直接推到主分支，调度者随后在主检出提交的状态就会和远端分叉；
// 只用 pull --ff-only 会卡住整轮调度。状态提交只含状态文件，变基是安全的。
// 负责人的其他未提交文件一律不碰：远端改了他正在编辑的文件时宁可不推送。
// 用法：
//   node .inbox/scripts/state-sync.mjs                   发现需求用：只同步 IDEAS.md 与发现账本
//   node .inbox/scripts/state-sync.mjs --all -m "<信息>"  调度者用：同步 INBOX.md、IDEAS.md、inbox/ 的全部改动，
//       同步成功后按最新记录运行 gc.mjs 回收没用的工作树和分支（状态推上去之后才删，删除依据和远端一致）
// 退出码：0 已同步（或无事可做）；1 没能同步（原因见输出，提交留在本地，下次再试）。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { argValue, isMain, normalize, paths, statePatterns } from './config.mjs'
import { collectGarbage } from './gc.mjs'

export const ideaFiles = [paths.ideas, paths.ledger]
export const allStateFiles = [paths.inbox, paths.ideas, `${paths.records}/`]

const run = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' })
const text = (result) => `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
const lines = (result) => (result.stdout ?? '').split('\n').filter(Boolean)
// 中文文件名在非 -z 输出里会被转义成八进制，凡是要和文件名比较的地方都用 -z。
const nulLines = (result) => (result.stdout ?? '').split('\0').filter(Boolean)
const isState = (file) => statePatterns.some((pattern) => pattern.test(file))

// 主检出是 worktree 列表的第一项；在需求工作树里调用时也写回主检出。
export function mainCheckout(cwd) {
  const first = lines(run(cwd, 'worktree', 'list', '--porcelain')).find((line) => line.startsWith('worktree '))
  return first ? first.slice('worktree '.length) : cwd
}

function inProgress(root) {
  return ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD'].some((name) => existsSync(path.resolve(root, run(root, 'rev-parse', '--git-path', name).stdout.trim())))
}

// 未提交的文件（含未跟踪），重命名条目带两个路径。
function dirtyFiles(root) {
  const entries = nulLines(run(root, 'status', '--porcelain', '-z', '--untracked-files=all'))
  const files = []
  for (let i = 0; i < entries.length; i++) {
    files.push(entries[i].slice(3))
    if (/^[RC]/.test(entries[i])) files.push(entries[++i])
  }
  return files
}

export function stateSync({ root, remote = 'origin', mainBranch = 'main', files = ideaFiles, message }) {
  const report = []
  const say = (line) => report.push(line)
  const fail = (line) => ({ ok: false, report: [...report, line] })
  const branch = run(root, 'symbolic-ref', '--short', '-q', 'HEAD').stdout.trim()
  if (branch !== mainBranch) return fail(`状态同步已跳过：主检出当前不在 ${mainBranch}（在「${branch || '游离 HEAD'}」）。`)
  if (inProgress(root)) return fail('状态同步已跳过：主检出正处于变基或合并中。')

  const inScope = (file) => files.some((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
  const changed = dirtyFiles(root).filter(inScope)
  if (changed.length) {
    // 路径限定提交：不带走暂存区或工作区里的其他文件。新文件先登记路径，才能被提交选中。
    const added = run(root, 'add', '--', ...changed)
    const label = message ?? `docs: 同步${changed.some((f) => f === paths.ideas) ? '想法簿' : ''}${changed.some((f) => f === paths.ledger) ? '发现账本' : ''}${changed.some((f) => !ideaFiles.includes(f)) ? '收件箱状态' : ''}`
    const committed = added.status === 0 ? run(root, 'commit', '-m', label, '--only', '--', ...changed) : added
    if (committed.status !== 0) return fail(`状态同步：提交失败：${text(committed)}`)
    say(`状态同步：已提交 ${changed.join('、')}。`)
  }

  const target = `${remote}/${mainBranch}`
  for (let attempt = 1; attempt <= 3; attempt++) {
    const fetched = run(root, 'fetch', remote, mainBranch)
    if (fetched.status !== 0) return fail(`状态同步：拉取 ${remote} 失败，提交留在本地：${text(fetched)}`)
    // 本地领先的提交只能是状态文件；混进别的文件说明不是调度流程造的，不替它推送。
    const ahead = nulLines(run(root, 'diff', '--name-only', '-z', `${target}...HEAD`))
    const foreign = ahead.filter((file) => !isState(file))
    if (foreign.length) return fail(`状态同步：本地 ${mainBranch} 领先的提交含有状态文件之外的改动（${foreign.join('、')}），不推送。请把这些改动移到工作树分支，用 integrate.mjs 集成。`)
    const behind = run(root, 'rev-list', '--count', `HEAD..${target}`).stdout.trim() !== '0'
    if (behind) {
      // 远端改了负责人正在编辑的文件：不变基，免得弄乱他的工作区。
      const incoming = nulLines(run(root, 'diff', '--name-only', '-z', `HEAD...${target}`))
      const mine = new Set(dirtyFiles(root))
      const clash = incoming.filter((file) => mine.has(file))
      if (clash.length) return fail(`状态同步：远端改了你正在编辑的 ${clash.join('、')}，本次不同步；提交留在本地。保存或提交这些文件后再运行。`)
      const rebased = run(root, '-c', 'rebase.autoStash=true', 'rebase', target)
      if (rebased.status !== 0) {
        run(root, 'rebase', '--abort')
        return fail(`状态同步：变基到 ${target} 冲突，已放弃，提交留在本地：${text(rebased)}`)
      }
      say(`状态同步：已跟上 ${target}。`)
    }
    if (!ahead.length) {
      if (!changed.length && !behind) say('状态同步：没有需要同步的改动。')
      return { ok: true, report }
    }
    const pushed = run(root, 'push', remote, `HEAD:${mainBranch}`)
    if (pushed.status === 0) {
      say(`状态同步：已推送到 ${mainBranch}。`)
      return { ok: true, report }
    }
    if (!/non-fast-forward|fetch first/.test(text(pushed))) return fail(`状态同步：推送失败，提交留在本地：${text(pushed)}`)
  }
  return fail(`状态同步：连续 3 次推送时 ${mainBranch} 都在前进，提交留在本地，稍后再运行。`)
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const root = argValue(args, '--root') ?? mainCheckout(process.cwd())
  const file = path.join(root, 'inbox.config.json')
  const { config } = normalize(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {})
  const all = args.includes('--all')
  const result = stateSync({ root, remote: config.remote, mainBranch: config.mainBranch, files: all ? allStateFiles : ideaFiles, message: argValue(args, '-m') })
  if (all && result.ok) {
    const { removed, kept } = collectGarbage(root, config)
    for (const r of removed) result.report.push(`回收：${r.id}（${r.status ?? ''}）删除了${r.removed.join('、')}。`)
    for (const k of kept) result.report.push(`回收：保留 ${k.id}：${k.reason}。`)
  }
  console.log(result.report.join('\n'))
  process.exitCode = result.ok ? 0 : 1
}
