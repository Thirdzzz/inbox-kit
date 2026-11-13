// 生成器：按 inbox.config.json 把收件箱的脚本、模板和技能写进目标仓库。可重复运行，结果只由配置和模板决定。
// 用法：node <kit>/scripts/render.mjs --repo <仓库路径> [--check]
//   不带 --check：写入或更新所有生成文件，缺失的状态文件（INBOX.md、inbox/模板.md 等）只创建、不覆盖。
//   --check：只检查生成文件是否与当前配置一致，不一致时退出码 1（配置改了却没重新生成）。
// <kit> 是 inbox-setup 技能里的 kit 目录，或目标仓库里的 .inbox（生成时会把自己复制过去，之后可脱离技能单独重跑）。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { argValue, isMain, paths, readConfig, worktreeBase } from './config.mjs'
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

const kitParts = ['scripts', 'templates', 'hooks', 'version.json']
const isDir = (p) => existsSync(p) && statSync(p).isDirectory()
const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16)
// kit 文件清单：相对 kit 根目录的路径 → 内容哈希。
function kitFiles(root) {
  const files = {}
  for (const part of kitParts) {
    const full = path.join(root, part)
    if (!existsSync(full)) continue
    for (const rel of isDir(full) ? walk(full).map((f) => path.join(part, f)) : [part]) files[rel] = sha(readFileSync(path.join(root, rel)))
  }
  return files
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

function ensureGitignore(repo, config) {
  const file = path.join(repo, '.gitignore')
  const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const lines = ['.inbox/decisions.tsv']
  // 工作树目录若在仓库内，也要忽略。
  const inside = path.relative(repo, worktreeBase(repo, config))
  if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) lines.push(`/${inside.split(path.sep).join('/')}/`)
  const missing = lines.filter((line) => !current.split('\n').includes(line))
  if (!missing.length) return false
  writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}# inbox 收件箱的本地文件\n${missing.join('\n')}\n`)
  return true
}

// 提交钩子：只有仓库完全没有在用的钩子时才设置 core.hooksPath=.inbox/hooks。
// 设了 hooksPath，.git/hooks 里的所有钩子（如 git-lfs 的 pre-push）都会失效，所以已有任何钩子时不抢，返回串接提示。
function ensureHook(repo, config) {
  const hint = '请在你现有的 pre-commit 钩子里加一行：node "$(git rev-parse --show-toplevel)/.inbox/scripts/main-guard.mjs" --staged'
  if (!config.guardMain) return '已按配置关闭主分支守卫，未安装提交钩子。'
  let current = ''
  try {
    current = execFileSync('git', ['-C', repo, 'config', '--get', 'core.hooksPath'], { encoding: 'utf8' }).trim()
  } catch {}
  if (current === '.inbox/hooks') return '提交钩子已启用（core.hooksPath=.inbox/hooks）。'
  if (current) return `仓库已在用 core.hooksPath=${current}，未覆盖。${hint}`
  const hooksDir = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-path', 'hooks'], { encoding: 'utf8' }).trim()
  const active = existsSync(hooksDir) ? readdirSync(hooksDir).filter((name) => !name.endsWith('.sample')) : []
  if (active.length) return `仓库的 .git/hooks 里已有钩子（${active.join('、')}），为免它们失效，未设置 core.hooksPath。${hint}`
  execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', '.inbox/hooks'])
  return '已启用提交钩子（core.hooksPath=.inbox/hooks），主分支上只能直接提交收件箱状态文件。注意：钩子只在本机生效，新克隆的仓库要重新运行 render.mjs；真正的保护请在远端开启分支保护。'
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
    // .inbox/ 与安装时记下的清单逐个比对：发现手改、缺失和升级后残留的旧文件。
    const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null
    if (!manifest?.kitFiles) problems.push('缺少 .inbox/generated.json 的文件清单（旧版本安装）')
    else {
      const actual = kitFiles(path.join(repo, '.inbox'))
      for (const [rel, hash] of Object.entries(manifest.kitFiles)) {
        if (!(rel in actual)) problems.push(`.inbox/${rel} 缺失`)
        else if (actual[rel] !== hash) problems.push(`.inbox/${rel} 与安装时不一致（被手改过）`)
      }
      for (const rel of Object.keys(actual)) if (!(rel in manifest.kitFiles)) problems.push(`.inbox/${rel} 是 kit 里没有的文件（升级残留或手工添加）`)
    }
    return { ok: problems.length === 0, problems }
  }

  const written = []
  // 1. 把 kit（脚本、模板、钩子）复制到 .inbox/，此后不依赖 inbox-setup 技能也能重新生成。
  const kitTarget = path.join(repo, '.inbox')
  if (path.resolve(kitTarget) !== kitRoot) {
    for (const part of kitParts) {
      const target = path.join(kitTarget, part)
      // 先删后拷：升级时 kit 里删掉的旧脚本不会残留。
      if (isDir(path.join(kitRoot, part))) rmSync(target, { recursive: true, force: true })
      cpSync(path.join(kitRoot, part), target, { recursive: true, force: true })
    }
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
  writeFileSync(manifestFile, `${JSON.stringify({ kitVersion, configHash: hash, files: [...planned.keys()].sort(), kitFiles: kitFiles(kitTarget) }, null, 2)}\n`)
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
