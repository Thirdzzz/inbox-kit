// 检查需求分支只写自己的结果文件，不碰调度者拥有的 INBOX.md、IDEAS.md 和 inbox/NNN-*.md。
// 为什么：调度者在主分支上改记录状态，子代理在分支上改同一份记录，变基时会反复冲突。
// 用法：在需求工作树里运行 node .inbox/scripts/check-ownership.mjs；不在 inbox/NNN 分支上时直接通过。
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { checkoutRoot, isMain, paths, readConfig } from './config.mjs'
import { readRecords, validateDependencies } from './dependencies.mjs'

export function findOwnershipViolations({ branch, changedFiles, inheritedResults = new Set(), enforceFrom = 1 }) {
  const match = /^inbox\/(\d{3})$/.exec(branch)
  if (!match || Number(match[1]) < enforceFrom) return []
  const own = `${paths.results}/${match[1]}.md`
  return changedFiles.filter((file) => (file === paths.inbox || file === paths.ideas || file.startsWith(`${paths.records}/`)) && file !== own && !inheritedResults.has(file))
}

export function formatViolations(branch, violations, mainRef) {
  const number = /^inbox\/(\d{3})$/.exec(branch)?.[1] ?? 'NNN'
  return [
    `需求分支 ${branch} 改动了调度者拥有的文件：`,
    ...violations.map((file) => `  - ${file}`),
    `请撤销这些改动（git checkout ${mainRef} -- <路径>；新建的文件直接删除），把进展和结果写进 ${paths.results}/${number}.md。`,
    '状态、预览和追问由调度者在主分支上写，分支里改同一份记录会在变基时冲突。',
  ]
}

// 依赖需求的结果文件会随依赖分支一起进来，原样继承时不算越权。
export function inheritedDependencyResults(branch, records, matchesDependency) {
  const id = /^inbox\/(\d{3})$/.exec(branch)?.[1]
  const byId = new Map(records.map((record) => [record.id, record]))
  validateDependencies(records)
  const found = new Set()
  const visit = (current) => {
    for (const dependency of byId.get(current)?.dependsOn ?? []) {
      if (found.has(dependency)) continue
      found.add(dependency)
      visit(dependency)
    }
  }
  visit(id)
  return new Set([...found].filter(matchesDependency).map((dependency) => `${paths.results}/${dependency}.md`))
}

if (isMain(import.meta.url)) {
  const root = checkoutRoot()
  const config = readConfig(root)
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  let branch = ''
  try {
    branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || git('symbolic-ref', '--short', '-q', 'HEAD')
  } catch {
    process.exit(0)
  }
  if (!/^inbox\/\d{3}$/.test(branch)) process.exit(0)
  const mainRef = `${config.remote}/${config.mainBranch}`
  let changed
  try {
    const base = git('merge-base', 'HEAD', mainRef)
    const z = (text) => text.split('\0').filter(Boolean)
    changed = [...new Set([...z(git('diff', '--name-only', '-z', base)), ...z(git('diff', '--cached', '--name-only', '-z', base)), ...z(git('ls-files', '-o', '--exclude-standard', '-z'))])]
  } catch {
    console.error(`无法找到 ${mainRef} 的合并基点，未能检查 ${branch}；请先 git fetch ${config.remote}（CI 需要完整历史）。`)
    process.exit(1)
  }
  const unchangedInherited = (id) => {
    try {
      const base = git('merge-base', `${config.remote}/inbox/${id}`, 'HEAD')
      const file = `${paths.results}/${id}.md`
      git('cat-file', '-e', `${base}:${file}`)
      git('diff', '--quiet', base, '--', file)
      return true
    } catch {
      return false
    }
  }
  // 先报越权：记录被分支改坏时，依赖也读不出来，但真正的问题是越权。
  let inherited = new Set()
  let dependencyError = ''
  try {
    inherited = inheritedDependencyResults(branch, readRecords(path.join(root, paths.records)), unchangedInherited)
  } catch (error) {
    dependencyError = error.message
  }
  const violations = findOwnershipViolations({ branch, changedFiles: changed, inheritedResults: inherited, enforceFrom: config.enforceFrom })
  if (violations.length) {
    console.error(formatViolations(branch, violations, mainRef).join('\n'))
    process.exit(1)
  }
  if (dependencyError) {
    console.error(`无法验证依赖：${dependencyError}`)
    process.exit(1)
  }
  console.log(`check-ownership：${branch} 只改了自己的文件。`)
}
