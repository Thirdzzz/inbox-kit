// 检查需求分支 inbox/NNN 的改动范围：
// - 只能写自己的结果文件，不碰调度者拥有的 INBOX.md、IDEAS.md、inbox/NNN-*.md；
// - 不能改流水线自身（.inbox/、inbox.config.json、.agents/skills/inbox*），否则子代理能改掉自己的合并门禁。
// 用法（主检出）：node .inbox/scripts/check-ownership.mjs <NNN>   检查该需求的工作树
// 用法（任意检出，如 CI）：node .inbox/scripts/check-ownership.mjs   检查当前检出所在的 inbox/NNN 分支
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { checkoutRoot, isMain, mainRoot, paths, pipelinePatterns, readConfig, worktreePath } from './config.mjs'
import { readRecords, validateDependencies } from './dependencies.mjs'

export function findOwnershipViolations({ branch, changedFiles, inheritedResults = new Set(), enforceFrom = 1 }) {
  const match = /^inbox\/(\d{3})$/.exec(branch)
  if (!match) return []
  const own = `${paths.results}/${match[1]}.md`
  const pipeline = changedFiles.filter((file) => pipelinePatterns.some((pattern) => pattern.test(file)))
  if (Number(match[1]) < enforceFrom) return pipeline
  const state = changedFiles.filter((file) => (file === paths.inbox || file === paths.ideas || file.startsWith(`${paths.records}/`)) && file !== own && !inheritedResults.has(file))
  return [...new Set([...state, ...pipeline])]
}

export function formatViolations(branch, violations, mainRef) {
  const number = /^inbox\/(\d{3})$/.exec(branch)?.[1] ?? 'NNN'
  return [
    `需求分支 ${branch} 改动了它不该改的文件：`,
    ...violations.map((file) => `  - ${file}`),
    `请撤销这些改动（git checkout ${mainRef} -- <路径>；新建的文件直接删除），把进展和结果写进 ${paths.results}/${number}.md。`,
    '收件箱状态由调度者在主分支上写；流水线自身（.inbox/、inbox.config.json、inbox 技能）只能在单独的维护分支里改，不能随需求分支合入。',
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

// cwd：分支所在的检出；recordsRoot：读取需求记录的位置（主检出，记录以主分支为准）。
export function checkBranch({ cwd, recordsRoot, config }) {
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  let branch = process.env.GITHUB_HEAD_REF || ''
  if (!branch) {
    try {
      branch = git('symbolic-ref', '--short', '-q', 'HEAD')
    } catch {
      branch = process.env.GITHUB_REF_NAME || ''
    }
  }
  if (!/^inbox\/\d{3}$/.test(branch)) return { ok: true, message: `check-ownership：${branch || '游离 HEAD'} 不是需求分支，跳过。` }
  const mainRef = `${config.remote}/${config.mainBranch}`
  let changed
  try {
    const base = git('merge-base', 'HEAD', mainRef)
    const z = (text) => text.split('\0').filter(Boolean)
    changed = [...new Set([...z(git('diff', '--name-only', '-z', base)), ...z(git('diff', '--cached', '--name-only', '-z', base)), ...z(git('ls-files', '-o', '--exclude-standard', '-z'))])]
  } catch {
    return { ok: false, message: `无法找到 ${mainRef} 的合并基点，未能检查 ${branch}；请先 git fetch ${config.remote}（CI 需要完整历史）。` }
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
  // 先报越权：记录被分支改坏时依赖也读不出来，但真正的问题是越权。
  let inherited = new Set()
  let dependencyError = ''
  try {
    inherited = inheritedDependencyResults(branch, readRecords(path.join(recordsRoot, paths.records)), unchangedInherited)
  } catch (error) {
    dependencyError = error.message
  }
  const violations = findOwnershipViolations({ branch, changedFiles: changed, inheritedResults: inherited, enforceFrom: config.enforceFrom })
  if (violations.length) return { ok: false, message: formatViolations(branch, violations, mainRef).join('\n') }
  if (dependencyError) return { ok: false, message: `无法验证依赖：${dependencyError}` }
  return { ok: true, message: `check-ownership：${branch} 只改了自己的文件。` }
}

if (isMain(import.meta.url)) {
  const [id] = process.argv.slice(2)
  try {
    const root = id ? mainRoot() : checkoutRoot()
    const config = readConfig(root)
    const result = checkBranch({ cwd: id ? worktreePath(root, config, id) : root, recordsRoot: root, config })
    if (result.ok) console.log(result.message)
    else {
      console.error(result.message)
      process.exitCode = 1
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
