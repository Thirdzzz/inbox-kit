// 判断一个需求分支是否必须停在「待检查」等负责人看过：改动命中 inbox.config.json 的 review.paths 就必须。
// 用法：在需求工作树里运行 node .inbox/scripts/needs-review.mjs；输出 JSON {"required": bool, "files": [...]}。
import { execFileSync } from 'node:child_process'
import { checkoutRoot, isMain, matchesAny, readConfig } from './config.mjs'

export function reviewHits(changedFiles, globs) {
  return changedFiles.filter((file) => matchesAny(file, globs))
}

if (isMain(import.meta.url)) {
  const root = checkoutRoot()
  const config = readConfig(root)
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  const base = git('merge-base', 'HEAD', `${config.remote}/${config.mainBranch}`)
  const changed = git('diff', '--name-only', '-z', base).split('\0').filter(Boolean)
  const files = reviewHits(changed, config.review.paths)
  console.log(JSON.stringify({ required: files.length > 0, files, rules: config.review.rules }, null, 2))
}
