// 判断一个需求分支是否必须停在「待检查」等负责人看过：改动命中 inbox.config.json 的 review.paths 就必须。
// 用法（主检出）：node .inbox/scripts/needs-review.mjs <NNN>；输出 JSON {"required": bool, "files": [...]}。
import { execFileSync } from 'node:child_process'
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
  const cwd = worktreePath(root, config, id)
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
  const base = git('merge-base', 'HEAD', `${config.remote}/${config.mainBranch}`)
  const changed = git('diff', '--name-only', '-z', base).split('\0').filter(Boolean)
  const files = reviewHits(changed, config.review.paths)
  console.log(JSON.stringify({ required: files.length > 0, files, rules: config.review.rules }, null, 2))
}
