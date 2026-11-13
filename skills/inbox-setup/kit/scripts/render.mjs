// 生成器：按 inbox.config.json 把收件箱的脚本、模板和技能写进目标仓库。可重复运行，结果只由配置和模板决定。
// 用法：node <kit>/scripts/render.mjs --repo <仓库路径> [--check]
//   不带 --check：写入或更新所有生成文件，缺失的状态文件（INBOX.md、inbox/模板.md 等）只创建、不覆盖。
//   --check：只检查生成文件是否与当前配置一致，不一致时退出码 1（配置改了却没重新生成）。
// <kit> 是 inbox-setup 技能里的 kit 目录，或目标仓库里的 .inbox（生成时会把自己复制过去，之后可脱离技能单独重跑）。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { argValue, isMain, paths, readConfig } from './config.mjs'
import { skillContext } from "./render-context.mjs"

export const kitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const kitVersion = JSON.parse(readFileSync(path.join(kitRoot, 'version.json'), 'utf8')).version

// {{a.b}} 取值；{{#flag}}…{{/flag}} 在 flag 为真时保留；{{^flag}}…{{/flag}} 在 flag 为假时保留。
export function fill(template, context) {
  const get = (key) => key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), context)
  // 独占一行的段落标签连同换行一起去掉，避免条件块留下空行。
  let text = template.replace(/^[ \t]*(\{\{[#^/][\w.]+\}\})[ \t]*\n/gm, '$1')
  for (let guard = 0; guard < 20; guard++) {
    const next = text.replace(/\{\{([#^])([\w.]+)\}\}((?:(?!\{\{[#^]\2\}\})[\s\S])*?)\{\{\/\2\}\}/g, (_, kind, key, body) => ((kind === '#') === Boolean(get(key)) ? body : ''))
    if (next === text) break
    text = next
  }
  const left = /\{\{[#^/][\w.]+\}\}/.exec(text)
  if (left) throw new Error(`模板段落标签没有配对：${left[0]}`)
  return text
    .replace(/\{\{([\w.]+)\}\}/g, (match, key) => {
      const value = get(key)
      if (value === undefined) throw new Error(`模板变量未定义：${match}`)
      return String(value)
    })
    .replace(/\n{3,}/g, '\n\n')
}

const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)).map((f) => path.join(entry.name, f)) : [entry.name]))

// 计划要写的生成文件：目标路径 → 内容。不含只创建一次的状态文件。
export function plan(repo, config) {
  const context = skillContext(config)
  const files = new Map()
  const skillsDir = path.join(kitRoot, 'templates/skills')
  for (const rel of walk(skillsDir)) {
    const target = path.join('.agents/skills', rel.replace(/\.tpl$/, ''))
    const raw = readFileSync(path.join(skillsDir, rel), 'utf8')
    files.set(target, rel.endsWith('.tpl') ? fill(raw, context) : raw)
  }
  return files
}

// 状态文件：仓库里没有才创建，之后归负责人和调度者所有，生成器不再改。
export function stateFiles(config) {
  const read = (name) => readFileSync(path.join(kitRoot, 'templates/state', name), 'utf8')
  const context = skillContext(config)
  return new Map([
    [paths.inbox, fill(read('INBOX.md'), context)],
    [paths.template, read('模板.md')],
    [paths.ledger, read('发现账本.md')],
    [`${paths.results}/.gitkeep`, ''],
  ])
}

export function configHash(config) {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 16)
}

const gitignoreLines = ['.inbox/worktrees/', '.inbox/decisions.tsv']

function ensureGitignore(repo, config) {
  const file = path.join(repo, '.gitignore')
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = [...gitignoreLines]
  if (!config.worktreeDir.startsWith('..') && config.worktreeDir !== '.inbox/worktrees') lines.push(`${config.worktreeDir.replace(/\/?$/, '/')}`)
  const missing = lines.filter((line) => !current.split('\n').includes(line))
  if (!missing.length) return false
  writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# inbox 收件箱的本地文件\n${missing.join('\n')}\n`)
  return true
}

// 提交钩子：仓库没有自定义钩子目录时启用 .inbox/hooks；已有（如 husky）时不抢，返回提示让人手工串接。
function ensureHook(repo, config) {
  if (!config.guardMain) return '已按配置关闭主分支守卫，未安装提交钩子。'
  let current = ''
  try {
    current = execFileSync('git', ['-C', repo, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim()
  } catch {}
  if (current && current !== '.inbox/hooks') return `仓库已在用 core.hooksPath=${current}，未覆盖。请在其 pre-commit 里加一行：node .inbox/scripts/main-guard.mjs --staged`
  const legacy = path.join(repo, '.git/hooks/pre-commit')
  if (!current && existsSync(legacy) && !readFileSync(legacy, 'utf8').includes('sample')) return `仓库已有 .git/hooks/pre-commit，未覆盖。请在其中加一行：node .inbox/scripts/main-guard.mjs --staged`
  execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.inbox/hooks'])
  return '已启用提交钩子（core.hooksPath=.inbox/hooks），主分支上只能直接提交收件箱状态文件。'
}

export function render(repo, { check = false } = {}) {
  const config = readConfig(repo)
  const planned = plan(repo, config)
  const hash = configHash(config)
  const manifestFile = path.join(repo, '.inbox/generated.json')

  if (check) {
    const problems = []
    for (const [rel, content] of planned) {
      const file = path.join(repo, rel)
      if (!existsSync(file)) problems.push(`缺少生成文件 ${rel}`)
      else if (readFileSync(file, 'utf8') !== content) problems.push(`生成文件与配置不一致：${rel}`)
    }
    const kitTarget = path.join(repo, '.inbox')
    if (path.resolve(kitTarget) !== kitRoot) {
      for (const rel of walk(path.join(kitRoot, 'scripts')).filter((f) => f.endsWith('.mjs'))) {
        const file = path.join(kitTarget, 'scripts', rel)
        if (!existsSync(file) || readFileSync(file, 'utf8') !== readFileSync(path.join(kitRoot, 'scripts', rel), 'utf8')) problems.push(`脚本与 kit 版本不一致：.inbox/scripts/${rel}`)
      }
    }
    return { ok: problems.length === 0, problems }
  }

  const written = []
  // 1. 把 kit（脚本、模板、钩子）复制到 .inbox/，此后不依赖 inbox-setup 技能也能重新生成。
  const kitTarget = path.join(repo, '.inbox')
  if (path.resolve(kitTarget) !== kitRoot) {
    for (const part of ['scripts', 'templates', 'hooks', 'version.json']) cpSync(path.join(kitRoot, part), path.join(kitTarget, part), { recursive: true, force: true })
    written.push('.inbox/（脚本、模板、钩子）')
  }
  chmodSync(path.join(kitTarget, 'hooks/pre-commit'), 0o755)
  // 2. 技能。
  for (const [rel, content] of planned) {
    const file = path.join(repo, rel)
    mkdirSync(path.dirname(file), { recursive: true })
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) {
      writeFileSync(file, content)
      written.push(rel)
    }
  }
  // 3. 状态文件只创建不覆盖。
  for (const [rel, content] of stateFiles(config)) {
    const file = path.join(repo, rel)
    if (existsSync(file)) continue
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, content)
    written.push(rel)
  }
  if (ensureGitignore(repo, config)) written.push('.gitignore')
  writeFileSync(manifestFile, `${JSON.stringify({ kitVersion, configHash: hash, files: [...planned.keys()].sort() }, null, 2)}\n`)
  const hook = ensureHook(repo, config)
  return { ok: true, written, hook }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const repo = path.resolve(argValue(args, '--repo') ?? process.cwd())
  try {
    const result = render(repo, { check: args.includes('--check') })
    if (args.includes('--check')) {
      if (result.ok) console.log('render --check：生成文件与配置一致。')
      else {
        console.error(`${result.problems.join('\n')}\n请运行 node .inbox/scripts/render.mjs --repo . 重新生成（改动走需求分支，再用 integrate.mjs 集成）。`)
        process.exitCode = 1
      }
    } else {
      console.log(result.written.length ? `已写入：\n- ${result.written.join('\n- ')}` : '生成文件已是最新。')
      console.log(result.hook)
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
