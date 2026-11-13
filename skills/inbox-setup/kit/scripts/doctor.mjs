// 体检：检查目标仓库能否运行收件箱。输出每项「通过 / 警告 / 失败」和修法，任一失败时退出码 1。
// 用法：node <kit>/scripts/doctor.mjs --repo <仓库路径> [--runtime codex|pi|custom] [--skip-commands]
// 不带 --skip-commands 时会真的执行一次 commands.check 和 commands.fullCheck，确认它们能在当前仓库跑通。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { argValue, isMain, normalize } from './config.mjs'

const run = (cwd, command, args, options = {}) => spawnSync(command, args, { cwd, encoding: 'utf8', ...options })
const has = (command) => run(process.cwd(), 'sh', ['-c', `command -v ${command}`]).status === 0

export function diagnose(repo, { runtime, skipCommands = false } = {}) {
  const items = []
  const add = (level, name, detail, fix = '') => items.push({ level, name, detail, fix })
  const git = (...args) => run(repo, 'git', args)

  const major = Number(process.versions.node.split('.')[0])
  if (major >= 18) add('ok', 'Node.js', `v${process.versions.node}`)
  else add('fail', 'Node.js', `v${process.versions.node}`, '需要 Node.js 18 或更高版本')

  if (git('rev-parse', '--show-toplevel').status !== 0) {
    add('fail', 'Git 仓库', `${repo} 不是 Git 仓库`, '先 git init 并提交一次')
    return items
  }
  const top = git('rev-parse', '--show-toplevel').stdout.trim()
  if (realpathSync(top) !== realpathSync(repo)) add('warn', 'Git 仓库', `${repo} 不是仓库根目录（根目录是 ${top}）`, '在仓库根目录安装')
  else add('ok', 'Git 仓库', top)

  const file = path.join(repo, 'inbox.config.json')
  let config = null
  if (!existsSync(file)) add('warn', '配置', '还没有 inbox.config.json', '按 inbox-setup 的问答生成')
  else {
    try {
      const { config: c, errors } = normalize(JSON.parse(readFileSync(file, 'utf8')))
      config = c
      if (errors.length) add('fail', '配置', errors.join('；'), '按提示修改 inbox.config.json')
      else add('ok', '配置', 'inbox.config.json 有效')
    } catch (error) {
      add('fail', '配置', `inbox.config.json 不是合法 JSON：${error.message}`, '修正 JSON 格式')
    }
  }
  const mainBranch = config?.mainBranch ?? 'main'
  const remote = config?.remote ?? 'origin'

  if (git('rev-parse', '--verify', '-q', 'HEAD').status !== 0) add('fail', '提交历史', '仓库还没有任何提交', '先提交一次')
  const current = git('symbolic-ref', '--short', '-q', 'HEAD').stdout.trim()
  if (git('rev-parse', '--verify', '-q', `refs/heads/${mainBranch}`).status !== 0) add('fail', '主分支', `本地没有分支 ${mainBranch}`, '在配置里把 mainBranch 改成实际的主分支名')
  else add(current === mainBranch ? 'ok' : 'warn', '主分支', current === mainBranch ? mainBranch : `当前在 ${current || '游离 HEAD'}，主分支是 ${mainBranch}`, current === mainBranch ? '' : '安装和调度都在主检出的主分支上进行')

  const remoteUrl = git('remote', 'get-url', remote).stdout.trim()
  // 本地相对路径的远端（如 ../remote.git）在需求工作树里会按工作树目录解析，推送必然失败。
  if (remoteUrl && /^\.{1,2}\//.test(remoteUrl)) {
    add('fail', '远端', `${remote} 是相对路径 ${remoteUrl}，在需求工作树里会解析到别处`, `git remote set-url ${remote} ${path.resolve(repo, remoteUrl)}`)
  } else if (!remoteUrl) add('fail', '远端', `没有远端 ${remote}`, `git remote add ${remote} <地址>；收件箱靠推送分支和主分支协作，没有远端无法合并`)
  else {
    const reach = git('ls-remote', '--heads', remote, mainBranch)
    if (reach.status !== 0) add('fail', '远端', `连不上 ${remote}（${remoteUrl}）：${reach.stderr.trim().split('\n').pop()}`, '检查网络、代理和凭据')
    else if (!reach.stdout.trim()) add('fail', '远端', `${remote} 上还没有 ${mainBranch}`, `git push -u ${remote} ${mainBranch}；需求工作树从 ${remote}/${mainBranch} 建出，没有它无法认领需求`)
    else add('ok', '远端', `${remote} → ${remoteUrl}`)
  }

  const dirty = git('status', '--porcelain').stdout.trim()
  if (dirty) add('warn', '工作区', `有未提交的改动（${dirty.split('\n').length} 项）`, '安装只提交收件箱自己的文件，你的改动不会被带上；也可以先提交')
  else add('ok', '工作区', '干净')

  const hooksPath = git('config', '--get', 'core.hooksPath').stdout.trim()
  const hooksDir = git('rev-parse', '--path-format=absolute', '--git-path', 'hooks').stdout.trim()
  const activeHooks = existsSync(hooksDir) ? readdirSync(hooksDir).filter((name) => !name.endsWith('.sample')) : []
  if (hooksPath && hooksPath !== '.inbox/hooks') add('warn', '提交钩子', `仓库已用 core.hooksPath=${hooksPath}`, '安装不会覆盖它；需要在其 pre-commit 里加一行 node .inbox/scripts/main-guard.mjs --staged')
  else if (!hooksPath && activeHooks.length) add('warn', '提交钩子', `.git/hooks 里已有 ${activeHooks.join('、')}`, '安装不会设置 core.hooksPath（会让它们失效）；需要在 pre-commit 里加一行 node .inbox/scripts/main-guard.mjs --staged')

  // 在 Codex 沙箱里运行时，网络和 .git 写入受限，调度者与子代理都无法工作。
  if (process.env.CODEX_SANDBOX && process.env.CODEX_SANDBOX_NETWORK_DISABLED === '1') add('fail', '运行环境', '当前在 Codex 沙箱里（不能联网，通常也不能写 .git）', '用完全访问模式运行 Codex（例如 codex --dangerously-bypass-approvals-and-sandbox，或在会话里切到 Full access）')

  const rt = runtime ?? config?.dev?.runtime ?? 'codex'
  if (rt === 'codex') {
    if (!has('codex')) add('fail', '开发运行时', '找不到 codex 命令', '安装 Codex CLI 并登录（codex login）')
    else add('ok', '开发运行时', `codex（${run(repo, 'codex', ['--version']).stdout.trim()}）；子代理以完全访问模式在各自工作树中运行`)
  } else if (rt === 'pi') {
    if (!has('pi')) add('fail', '开发运行时', '找不到 pi 命令', '安装 pi 并配置模型凭据')
    else add('ok', '开发运行时', 'pi；子代理以 pi -p 在各自工作树中运行')
  } else add('ok', '开发运行时', `自定义命令：${config?.dev?.command ?? ''}`)

  if (config?.deploy?.verify === 'github-status') {
    if (!has('gh')) add('fail', 'GitHub CLI', '部署确认用 github-status，但找不到 gh', '安装 gh 并 gh auth login')
    else if (run(repo, 'gh', ['auth', 'status']).status !== 0) add('fail', 'GitHub CLI', 'gh 没有登录', 'gh auth login')
    else add('ok', 'GitHub CLI', '已登录')
  }

  if (config && !skipCommands) {
    for (const [key, label] of [['check', '子代理检查'], ['fullCheck', '合并前完整检查']]) {
      const command = config.commands[key]
      if (!command) continue
      const result = run(repo, 'sh', ['-c', command], { timeout: 15 * 60000 })
      const tail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-5).join(' / ')
      if (result.status === 0) add('ok', label, `\`${command}\` 退出码 0`)
      else add('fail', label, `\`${command}\` 退出码 ${result.status ?? '超时'}：${tail}`, '先让这条命令在主分支上跑通；它失败时，任何需求都合并不进去')
      if (key === 'check' && command === config.commands.fullCheck) break
    }
  }
  return items
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const repo = path.resolve(argValue(args, '--repo') ?? process.cwd())
  const items = diagnose(repo, { runtime: argValue(args, '--runtime'), skipCommands: args.includes('--skip-commands') })
  const mark = { ok: '✓', warn: '!', fail: '✗' }
  for (const { level, name, detail, fix } of items) console.log(`${mark[level]} ${name}：${detail}${fix ? `\n    → ${fix}` : ''}`)
  const failed = items.filter((item) => item.level === 'fail').length
  console.log(failed ? `\n有 ${failed} 项失败，修好后再继续。` : '\n体检通过。')
  process.exitCode = failed ? 1 : 0
}
