// 守住主分支：除收件箱状态文件（INBOX.md、IDEAS.md、inbox/）外，任何文件都不得直接在主分支上提交。
// 代码、技能、文档都应在独立工作树的分支里改好，再用 integrate.mjs 集成。
// 由 Git 的 pre-commit 钩子调用：node .inbox/scripts/main-guard.mjs --staged
// 紧急例外：INBOX_ALLOW_MAIN_COMMIT=1（提交后不要推送，先补走正常流程）。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { isMain, normalize, statePatterns } from './config.mjs'

export function findMainViolations(files) {
  return files.filter((file) => !statePatterns.some((pattern) => pattern.test(file)))
}

export function formatMainViolations(violations, mainBranch = 'main') {
  return [
    `不能直接在 ${mainBranch} 上提交这些文件：${violations.join('、')}`,
    '请在独立工作树的新分支里修改，验证后在该工作树运行 node .inbox/scripts/integrate.mjs 集成。',
    '确需例外（紧急修复，且不推送）：加环境变量 INBOX_ALLOW_MAIN_COMMIT=1 重试。',
  ]
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })

export function branchOf(cwd) {
  try {
    return git(cwd, 'symbolic-ref', '--short', '-q', 'HEAD').trim()
  } catch {
    return ''
  }
}

function mainBranchOf(cwd) {
  try {
    const file = path.join(git(cwd, 'rev-parse', '--show-toplevel').trim(), 'inbox.config.json')
    if (existsSync(file)) return normalize(JSON.parse(readFileSync(file, 'utf8'))).config.mainBranch
  } catch {}
  return 'main'
}

if (isMain(import.meta.url) && process.argv[2] === '--staged') {
  const cwd = process.cwd()
  const mainBranch = mainBranchOf(cwd)
  if (process.env.INBOX_ALLOW_MAIN_COMMIT === '1' || branchOf(cwd) !== mainBranch) process.exit(0)
  const staged = git(cwd, 'diff', '--cached', '--name-only', '-z').split('\0').filter(Boolean)
  const violations = findMainViolations(staged)
  if (violations.length) {
    console.error(formatMainViolations(violations, mainBranch).join('\n'))
    process.exit(1)
  }
}
