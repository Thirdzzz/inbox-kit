// 读取仓库根目录的 inbox.config.json，补齐默认值。所有收件箱脚本都从这里取路径和参数，不写死项目细节。
// 本文件由 inbox-kit 生成；改配置请改 inbox.config.json，再运行 inbox-kit render。
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const defaults = {
  projectName: '',
  mainBranch: 'main',
  remote: 'origin',
  worktreeDir: '.inbox/worktrees',
  slots: 3,
  maxAutoRetries: 3,
  idleLimitMinutes: 15,
  subagentTimeoutMinutes: 30,
  enforceFrom: 1,
  commands: {
    install: '',
    check: '',
    fullCheck: '',
  },
  deploy: {
    mode: 'none',
    verify: 'none',
    verifyCommand: '',
    previewCommand: '',
    postMergeCommand: '',
    budget: '',
  },
  review: {
    paths: [],
    rules: [],
  },
  product: {
    summary: '',
    docs: [],
    glossary: '',
    roadmap: '',
    scenarios: [],
    codeDirs: [],
    walkthrough: '',
  },
  // 开发子代理的运行方式：codex、pi，或 custom（自填命令模板，可接其他命令行 Agent）。
  dev: {
    runtime: 'codex',
    model: '',
    command: '',
  },
  guardMain: true,
  ci: false,
}

// 固定路径：状态文件可以由调度者直接提交到主分支，其余文件必须走工作树分支加集成脚本。
export const paths = {
  inbox: 'INBOX.md',
  ideas: 'IDEAS.md',
  records: 'inbox',
  results: 'inbox/results',
  ledger: 'inbox/发现账本.md',
  template: 'inbox/模板.md',
  decisionLog: '.inbox/decisions.tsv',
}
export const statePatterns = [/^INBOX\.md$/, /^IDEAS\.md$/, /^inbox\//]
export const inboxMarker = '<!-- ===== 需求区（从这里往下写） ===== -->'
export const statuses = ['待办', '进行中', '需要补充', '待检查', '已上线', '失败', '已否决']
export const blockerTags = ['预算', '凭据', '不可逆数据', '验收无法判定']

function merge(base, extra) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return extra === undefined ? base : extra
  const out = { ...base }
  for (const [key, value] of Object.entries(extra ?? {})) out[key] = key in base ? merge(base[key], value) : value
  return out
}

export function normalize(raw) {
  const config = merge(defaults, raw)
  const errors = []
  if (!['none', 'push', 'command'].includes(config.deploy.mode)) errors.push(`deploy.mode 只能是 none、push、command，实际是「${config.deploy.mode}」`)
  if (!['none', 'github-status', 'command'].includes(config.deploy.verify)) errors.push(`deploy.verify 只能是 none、github-status、command，实际是「${config.deploy.verify}」`)
  if (config.deploy.verify === 'command' && !config.deploy.verifyCommand) errors.push('deploy.verify 为 command 时必须填 deploy.verifyCommand')
  if (config.deploy.mode === 'command' && !config.deploy.postMergeCommand) errors.push('deploy.mode 为 command 时必须填 deploy.postMergeCommand')
  if (!config.commands.check) errors.push('commands.check 必填：子代理交付前要跑的检查命令')
  if (!config.commands.fullCheck) errors.push('commands.fullCheck 必填：合并到主分支前的完整检查命令')
  for (const key of ['slots', 'maxAutoRetries', 'idleLimitMinutes', 'subagentTimeoutMinutes', 'enforceFrom']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) errors.push(`${key} 必须是正整数`)
  }
  if (!['codex', 'pi', 'custom'].includes(config.dev.runtime)) errors.push(`dev.runtime 只能是 codex、pi、custom，实际是「${config.dev.runtime}」`)
  if (config.dev.runtime === 'custom' && !config.dev.command.includes('{prompt_file}')) errors.push('dev.runtime 为 custom 时，dev.command 必须包含 {prompt_file}')
  if (!/^[\w./-]+$/.test(config.worktreeDir) || config.worktreeDir.startsWith('/')) errors.push('worktreeDir 必须是仓库内的相对路径')
  return { config, errors }
}

export function readConfig(root) {
  const file = path.join(root, 'inbox.config.json')
  if (!existsSync(file)) throw new Error(`找不到 ${file}；先运行 /skill:inbox-setup`)
  const { config, errors } = normalize(JSON.parse(readFileSync(file, 'utf8')))
  if (errors.length) throw new Error(`inbox.config.json 有误：\n- ${errors.join('\n- ')}`)
  return config
}

export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

// 当前检出（主检出或需求工作树）的根目录，以运行目录为准。
export const checkoutRoot = (cwd = process.cwd()) => git(cwd, 'rev-parse', '--show-toplevel')

// 主检出根目录：所有工作树共享同一个 .git，需求工作树都挂在主检出下。
export function mainRoot(cwd = process.cwd()) {
  return git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').replace(/\/\.git\/?$/, '')
}

export const argValue = (args, flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined)

// 简单的路径通配：** 匹配任意层目录，* 匹配一段路径内的任意字符。
export function globToRegExp(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

export const matchesAny = (file, globs) => globs.some((glob) => globToRegExp(glob).test(file))

export const isMain = (url) => Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(url)
