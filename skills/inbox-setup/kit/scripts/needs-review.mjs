// 判断一个需求分支是否必须停在「待检查」等负责人看过：改动命中 inbox.config.json 的 review.paths 就必须。
// 用法（主检出）：node .inbox/scripts/needs-review.mjs <NNN>；输出 JSON {"required": bool, "files": [...]}。
// 工作树还在就看工作树的 HEAD；已清理（如停在待检查）就看远端分支 <remote>/inbox/NNN。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isMain, mainRoot, matchesAny, readConfig, worktreePath } from './config.mjs'

export function reviewHits(changedFiles, globs) {
  return changedFiles.filter((file) => matchesAny(file, globs))
}

if (isMain(import.meta.url)) {
  const root = mainRoot()
  const config = readConfig(root)
  const id = process.argv[2]
  if (!/^\d{3}$/.test(id ?? '')) {
    console.error('用法：node .inbox/scripts/needs-review.mjs <NNN>')
    process.exit(2)
  }
  const worktree = worktreePath(root, config, id)
  const local = existsSync(worktree)
  const cwd = local ? worktree : root
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  const head = local ? 'HEAD' : `${config.remote}/inbox/${id}`
  if (!local) git('fetch', config.remote, `+inbox/${id}:refs/remotes/${config.remote}/inbox/${id}`)
  const base = git('merge-base', head, `${config.remote}/${config.mainBranch}`)
  const changed = git('diff', '--name-only', '-z', base, head).split('\0').filter(Boolean)
  const files = reviewHits(changed, config.review.paths)
  console.log(JSON.stringify({ required: files.length > 0, files, rules: config.review.rules }, null, 2))
}
