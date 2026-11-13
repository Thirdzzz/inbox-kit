// 探测仓库，给出 inbox.config.json 的建议值和依据。只读，不写文件。
// inbox-setup 用它给每个问题准备「推荐答案」，让负责人大多只需确认。
// 用法：node <kit>/scripts/detect.mjs --repo <仓库路径>，输出 JSON：{ suggested, evidence, questions }
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { argValue, isMain } from './config.mjs'

const exists = (repo, rel) => existsSync(path.join(repo, rel))
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

// 在仓库根目录和一层子目录里找带脚本的 package.json（前端常放在 app/、web/ 下）。
function findNodePackage(repo) {
  const candidates = ['.', ...readdirSync(repo, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name)]
  for (const dir of candidates) {
    const pkg = readJson(path.join(repo, dir, 'package.json'))
    if (pkg?.scripts && Object.keys(pkg.scripts).length) return { dir, pkg }
  }
  return null
}

function nodeCommands(repo, { dir, pkg }) {
  const scripts = pkg.scripts
  const manager = exists(repo, path.join(dir, 'pnpm-lock.yaml')) ? 'pnpm' : exists(repo, path.join(dir, 'yarn.lock')) ? 'yarn' : exists(repo, path.join(dir, 'bun.lockb')) || exists(repo, path.join(dir, 'bun.lock')) ? 'bun' : 'npm'
  const runScript = (name) => (manager === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${manager} ${name === 'test' ? 'test' : `run ${name}`}`)
  const prefix = dir === '.' ? '' : `cd ${dir} && `
  const quick = ['lint', 'typecheck', 'build', 'test'].filter((name) => scripts[name] && !/no test specified/.test(scripts[name])).map(runScript)
  const e2e = Object.keys(scripts).filter((name) => /^(test:)?e2e$|^e2e:|playwright|cypress/.test(name))
  const install = manager === 'npm' ? (exists(repo, path.join(dir, 'package-lock.json')) ? 'npm ci' : 'npm install') : `${manager} install`
  return {
    install: `${prefix}${install}`,
    check: quick.length ? `${prefix}${quick.join(' && ')}` : '',
    fullCheck: quick.length || e2e.length ? `${prefix}${[...quick, ...e2e.slice(0, 1).map(runScript)].join(' && ')}` : '',
    evidence: `${dir === '.' ? '' : `${dir}/`}package.json 的 scripts：${Object.keys(scripts).join('、')}；包管理器 ${manager}`,
  }
}

export function detect(repo) {
  const evidence = []
  const suggested = { projectName: path.basename(repo), commands: {}, deploy: { mode: 'none', verify: 'none' }, review: { paths: [], rules: [] }, product: { docs: [], codeDirs: [] }, dev: {} }
  const git = (...args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })

  // 主分支与远端
  const remotes = git('remote').stdout.split('\n').filter(Boolean)
  const remote = remotes.includes('origin') ? 'origin' : remotes[0] ?? 'origin'
  suggested.remote = remote
  const head = git('symbolic-ref', '--short', '-q', `refs/remotes/${remote}/HEAD`).stdout.trim().replace(`${remote}/`, '')
  const local = git('symbolic-ref', '--short', '-q', 'HEAD').stdout.trim()
  suggested.mainBranch = head || (['main', 'master'].find((b) => git('rev-parse', '--verify', '-q', `refs/heads/${b}`).status === 0) ?? local) || 'main'
  evidence.push(`主分支：${head ? `远端 HEAD 指向 ${head}` : `本地分支推断为 ${suggested.mainBranch}`}；远端 ${remotes.length ? remotes.join('、') : '无'}`)

  // 检查命令
  const node = findNodePackage(repo)
  if (node) {
    const cmds = nodeCommands(repo, node)
    Object.assign(suggested.commands, { install: cmds.install, check: cmds.check, fullCheck: cmds.fullCheck })
    evidence.push(cmds.evidence)
    suggested.product.codeDirs.push(...['src', 'app', 'lib', 'pages', 'components'].map((d) => (node.dir === '.' ? d : `${node.dir}/${d}`)).filter((d) => exists(repo, d)))
  } else if (exists(repo, 'pyproject.toml') || exists(repo, 'requirements.txt')) {
    const tests = exists(repo, 'tests') || exists(repo, 'test')
    suggested.commands.install = exists(repo, 'uv.lock') ? 'uv sync' : exists(repo, 'requirements.txt') ? 'pip install -r requirements.txt' : 'pip install -e .'
    suggested.commands.check = tests ? (exists(repo, 'uv.lock') ? 'uv run pytest -q' : 'python -m pytest -q') : ''
    suggested.commands.fullCheck = suggested.commands.check
    evidence.push(`Python 项目（${exists(repo, 'uv.lock') ? 'uv' : 'pip'}）；${tests ? '有 tests 目录' : '没找到测试目录'}`)
  } else if (exists(repo, 'Cargo.toml')) {
    Object.assign(suggested.commands, { check: 'cargo test', fullCheck: 'cargo clippy -- -D warnings && cargo test' })
    evidence.push('Rust 项目（Cargo.toml）')
  } else if (exists(repo, 'go.mod')) {
    Object.assign(suggested.commands, { check: 'go vet ./... && go test ./...', fullCheck: 'go vet ./... && go test ./...' })
    evidence.push('Go 项目（go.mod）')
  } else if (exists(repo, 'Makefile') && /^test:/m.test(readFileSync(path.join(repo, 'Makefile'), 'utf8'))) {
    Object.assign(suggested.commands, { check: 'make test', fullCheck: 'make test' })
    evidence.push('Makefile 里有 test 目标')
  } else evidence.push('没认出项目类型，检查命令需要你提供')
  if (!suggested.product.codeDirs.length) suggested.product.codeDirs = ['src', 'lib', 'app'].filter((d) => exists(repo, d))

  // 部署
  const workflows = exists(repo, '.github/workflows') ? readdirSync(path.join(repo, '.github/workflows')) : []
  const vercel = ['vercel.json', '.vercel'].some((f) => exists(repo, f)) || (node && exists(repo, path.join(node.dir, 'vercel.json')))
  const netlify = exists(repo, 'netlify.toml')
  const deployWorkflow = workflows.find((f) => /deploy|release|pages|publish/i.test(f))
  if (vercel || netlify || deployWorkflow) {
    suggested.deploy = { mode: 'push', verify: remotes.length && /github\.com/.test(git('remote', 'get-url', remote).stdout) ? 'github-status' : 'none' }
    evidence.push(`部署：${[vercel && 'Vercel', netlify && 'Netlify', deployWorkflow && `.github/workflows/${deployWorkflow}`].filter(Boolean).join('、')}，推测推送主分支即部署`)
  } else evidence.push('部署：没发现部署配置，推测没有自动部署')
  if (workflows.length) suggested.ci = true

  // 产品文档
  for (const doc of ['PRODUCT.md', 'README.md', 'DESIGN.md', 'docs/roadmap.md', 'ROADMAP.md']) if (exists(repo, doc)) suggested.product.docs.push(doc)
  const glossary = ['GLOSSARY.md', 'CONTEXT.md', 'docs/glossary.md'].find((f) => exists(repo, f))
  if (glossary) suggested.product.glossary = glossary
  const roadmap = ['docs/roadmap.md', 'ROADMAP.md'].find((f) => exists(repo, f))
  if (roadmap) suggested.product.roadmap = roadmap
  evidence.push(`产品文档：${suggested.product.docs.join('、') || '无'}${glossary ? `；术语表 ${glossary}` : ''}`)

  // 高风险路径
  const risky = ['migrations', 'db/migrations', 'prisma/schema.prisma', 'schema.sql', 'alembic']
  for (const p of risky) if (exists(repo, p)) suggested.review.paths.push(p.includes('.') ? p : `${p}/**`)
  if (suggested.review.paths.length) evidence.push(`可能改动数据格式的路径：${suggested.review.paths.join('、')}`)

  // 运行时
  const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0
  suggested.dev.runtime = has('codex') ? 'codex' : has('pi') ? 'pi' : 'codex'
  evidence.push(`本机可用的开发运行时：${['codex', 'pi'].filter(has).join('、') || '无'}`)

  const questions = []
  if (!suggested.commands.check) questions.push('commands.check')
  if (!suggested.commands.fullCheck) questions.push('commands.fullCheck')
  if (!remotes.length) questions.push('remote')
  return { suggested, evidence, questions }
}

if (isMain(import.meta.url)) {
  const repo = path.resolve(argValue(process.argv.slice(2), '--repo') ?? process.cwd())
  console.log(JSON.stringify(detect(repo), null, 2))
}
