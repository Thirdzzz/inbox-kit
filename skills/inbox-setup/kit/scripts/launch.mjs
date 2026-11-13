// 开发子代理的启动、等待、停止与结果读取。子代理是一个独立进程（自成进程组），工作目录就是需求工作树：
// pi 与 Codex 的原生子代理都和调度者共用目录，也不保证发完成通知，所以统一用进程，由看门狗按真实动静判断死活。
// 运行文件放在该工作树私有的 git 目录里（不进版本库，随工作树删除）：
//   inbox-agent-id（pid:<进程号>@<启动时间>） inbox-agent.log（全部输出） inbox-agent-last.txt（最终回复）
//   inbox-agent-exit（子代理的退出码） inbox-agent-prompt.md（任务说明）
// 用法（都在主检出运行）：
//   node .inbox/scripts/launch.mjs start <NNN> [--note "<附加说明>"] [--retry]
//       用 brief.mjs 生成任务说明并启动，立即返回。记录必须是「进行中」；--retry 会先把「待办」改回「进行中」并提交推送。
//   node .inbox/scripts/launch.mjs start <NNN> --prompt-file <文件>   用自备的任务说明启动
//   node .inbox/scripts/launch.mjs wait [--minutes 2]   等到任一子代理需要处理或时间到，输出看门狗 JSON
//   node .inbox/scripts/launch.mjs stop <NNN>           停掉子代理的整个进程组（核对身份后才停）
//   node .inbox/scripts/launch.mjs result <NNN>         输出退出码、结果文件里的「返回：」、最终回复
import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { argValue, git, isMain, mainRoot, paths, readConfig, worktreePath } from './config.mjs'
import { advice, inspectAll } from './watchdog.mjs'
import { buildBrief } from './brief.mjs'
import { stateSync } from './state-sync.mjs'
import { formatAgentId, groupAlive, isOurProcess, killGroup, parseAgentId, startTimeOf } from './process.mjs'

export const runFile = (worktree, name) => git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', name)

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`

// pi 的 JSON 事件流里取最后一条助手回复。
export const piLastMessage = (jsonl) => {
  for (const line of jsonl.split('\n').reverse()) {
    try {
      const event = JSON.parse(line)
      if (event.type !== 'agent_end') continue
      const message = event.messages?.filter((m) => m.role === 'assistant').at(-1)
      return (message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n')
    } catch {}
  }
  return ''
}

// 返回要交给 sh -c 的命令，它的退出码就是子代理的退出码。提示词一律从文件读，避免转义问题。
export function agentCommand(dev, { worktree, promptFile, lastFile }) {
  const model = dev.model ? ` ${dev.runtime === 'codex' ? '-m' : '--model'} ${quote(dev.model)}` : ''
  if (dev.runtime === 'codex') {
    // 子代理要写 .git（提交、推送）并联网，Codex 的工作区沙箱都会拦，所以按完全访问运行；它只在自己的工作树里工作。
    return `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C ${quote(worktree)} -o ${quote(lastFile)}${model} "$(cat ${quote(promptFile)})" < /dev/null`
  }
  if (dev.runtime === 'pi') {
    // JSON 模式边跑边输出事件，日志持续更新，看门狗不会把长时间思考误判为卡死；结束后由 result 从日志里取最终回复。
    // 不用 --approve：它会信任工作树里的项目扩展（.pi/），分支内容不应获得这种权限。
    return `pi --mode json -p --no-session${model} "$(cat ${quote(promptFile)})" < /dev/null`
  }
  return dev.command.replaceAll('{prompt_file}', quote(promptFile)).replaceAll('{worktree}', quote(worktree)).replaceAll('{last_message}', quote(lastFile))
}

const recordOf = (root, id) => {
  const dir = path.join(root, paths.records)
  const records = existsSync(dir) ? readdirSync(dir).filter((name) => name.startsWith(`${id}-`) && name.endsWith('.md')) : []
  if (records.length !== 1) throw new Error(`inbox/ 中应恰好有一个 ${id}-*.md，实际 ${records.length} 个`)
  return records[0]
}

// 重试：把记录和 INBOX.md 标题从「待办」改回「进行中」，经 state-sync 提交并推送（同步失败只提示，提交留在本地）。
export function markRetry(root, config, id) {
  const recordRel = `${paths.records}/${recordOf(root, id)}`
  const recordFile = path.join(root, recordRel)
  const record = readFileSync(recordFile, 'utf8')
  if (!/^status: 待办$/m.test(record)) throw new Error(`--retry 只用于「待办」的需求，${id} 现在是「${/^status:\s*(\S+)/m.exec(record)?.[1]}」`)
  writeFileSync(recordFile, record.replace(/^status: 待办$/m, 'status: 进行中'))
  const inboxFile = path.join(root, paths.inbox)
  const inbox = readFileSync(inboxFile, 'utf8')
  if (!inbox.includes(`## [${id} · 待办]`)) throw new Error(`INBOX.md 里找不到「${id} · 待办」标题`)
  writeFileSync(inboxFile, inbox.replace(`## [${id} · 待办]`, `## [${id} · 进行中]`))
  const synced = stateSync({ root, remote: config.remote, mainBranch: config.mainBranch, files: [paths.inbox, recordRel], message: `docs: 重新派发需求 ${id}` })
  return synced.ok ? '' : synced.report.join(' ')
}

export function start(root, config, id, { promptFile, note = '', retry = false } = {}) {
  const worktree = worktreePath(root, config, id)
  if (!existsSync(worktree)) throw new Error(`没有工作树 ${worktree}；先运行 node .inbox/scripts/worktree.mjs claim ${id}`)
  const idFile = runFile(worktree, 'inbox-agent-id')
  if (existsSync(idFile) && isOurProcess(readFileSync(idFile, 'utf8').trim())) throw new Error(`${id} 已有子代理在运行；先 node .inbox/scripts/launch.mjs stop ${id} 再重派`)
  const warning = retry ? markRetry(root, config, id) : ''
  // 记录必须是「进行中」：看门狗只盯「进行中」的需求，没标就启动的子代理结束后没人收尾。
  const record = recordOf(root, id)
  const status = /^status:\s*(\S+)/m.exec(readFileSync(path.join(root, paths.records, record), 'utf8'))?.[1]
  if (status !== '进行中') throw new Error(`${id} 的记录状态是「${status}」。新派发：先把记录和 INBOX.md 标题改成「进行中」并提交；重试：加 --retry。`)
  const saved = runFile(worktree, 'inbox-agent-prompt.md')
  if (promptFile) {
    const prompt = path.resolve(promptFile)
    if (!existsSync(prompt)) throw new Error(`找不到提示词文件 ${prompt}`)
    writeFileSync(saved, readFileSync(prompt, 'utf8'))
  } else writeFileSync(saved, buildBrief(config, { id, worktree, recordFile: `${paths.records}/${record}`, note }))
  const lastFile = runFile(worktree, 'inbox-agent-last.txt')
  const exitFile = runFile(worktree, 'inbox-agent-exit')
  for (const file of [lastFile, exitFile]) rmSync(file, { force: true })
  const log = openSync(runFile(worktree, 'inbox-agent.log'), 'w')
  const command = agentCommand(config.dev, { worktree, promptFile: saved, lastFile })
  // 外层 sh 记下退出码；detached 让子代理自成进程组，调度者结束也不会带走它，stop 时整组停掉。
  const child = spawn('sh', ['-c', `${command}\necho $? > ${quote(exitFile)}`], { cwd: worktree, detached: true, stdio: ['ignore', log, log], env: { ...process.env, INBOX_REQUIREMENT: id } })
  child.unref()
  writeFileSync(idFile, `${formatAgentId(child.pid, startTimeOf(child.pid))}\n`)
  return { id, pid: child.pid, worktree, runtime: config.dev.runtime, log: runFile(worktree, 'inbox-agent.log'), ...(warning ? { warning } : {}) }
}

export function stop(root, config, id) {
  const worktree = worktreePath(root, config, id)
  if (!existsSync(worktree)) return `${id}：没有工作树`
  const idFile = runFile(worktree, 'inbox-agent-id')
  const agentId = existsSync(idFile) ? readFileSync(idFile, 'utf8').trim() : ''
  const { pid } = parseAgentId(agentId)
  if (isOurProcess(agentId)) {
    killGroup(pid)
    return `${id}：已停止子代理（进程组 ${pid}）`
  }
  // 主进程已不在：只回收它留下的后台进程。进程组号在组内还有进程时不会被复用，所以按组停是安全的。
  if (pid && groupAlive(pid) && existsSync(runFile(worktree, 'inbox-agent-exit'))) {
    killGroup(pid)
    return `${id}：子代理已结束，已回收它留下的后台进程（进程组 ${pid}）`
  }
  return `${id}：没有在运行的子代理`
}

export function result(root, config, id) {
  const worktree = worktreePath(root, config, id)
  const read = (name) => {
    const file = runFile(worktree, name)
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }
  const exitText = read('inbox-agent-exit').trim()
  const resultsFile = path.join(worktree, paths.results, `${id}.md`)
  const results = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8') : ''
  const declared = /^返回[：:]\s*(ready|needs-info|failed)\b/m.exec(results)?.[1] ?? ''
  const log = read('inbox-agent.log')
  const last = read('inbox-agent-last.txt').trim() || (config.dev.runtime === 'pi' ? piLastMessage(log) : '')
  return {
    id,
    exitCode: exitText === '' ? null : Number(exitText),
    returned: declared || null,
    resultsFile: results ? resultsFile : null,
    lastMessage: last.slice(-3000),
    logTail: log.trim().split('\n').slice(-20).map((line) => line.slice(0, 400)).join('\n'),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 有界等待：任一子代理需要处理就返回；没有在跑的子代理时立即返回。
// 默认只等 2 分钟：调度者的命令工具大多有单条命令超时，等太久会被工具杀掉。调度者循环调用它即可。
export async function wait(root, config, { minutes = 2, pollSeconds = 15 } = {}) {
  let delay = 1
  const deadline = Date.now() + minutes * 60000
  const options = { idleLimit: config.idleLimitMinutes, timeLimit: config.subagentTimeoutMinutes }
  for (;;) {
    const states = inspectAll(root, config, options)
    const running = states.filter((s) => s.state === 'live' || s.state === 'launching')
    const needsAction = states.filter((s) => !running.includes(s) && s.state !== 'parked')
    if (needsAction.length || !running.length) return { timedOut: false, running: running.map((s) => s.id), needsAction: needsAction.map((s) => ({ id: s.id, state: s.state, advice: advice[s.state]?.(s.id, s) })), states }
    if (Date.now() >= deadline) return { timedOut: true, running: running.map((s) => s.id), needsAction: [], states }
    await sleep(delay * 1000)
    delay = Math.min(delay * 2, pollSeconds)
  }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const [command, id] = args
  try {
    const root = mainRoot()
    const config = readConfig(root)
    if (command === 'start') console.log(JSON.stringify(start(root, config, id, { promptFile: argValue(args, '--prompt-file'), note: argValue(args, '--note') ?? '', retry: args.includes('--retry') }), null, 2))
    else if (command === 'stop') console.log(stop(root, config, id))
    else if (command === 'result') console.log(JSON.stringify(result(root, config, id), null, 2))
    else if (command === 'wait') console.log(JSON.stringify(await wait(root, config, { minutes: Number(argValue(args, '--minutes') ?? 2) }), null, 2))
    else {
      console.error('用法：launch.mjs start <NNN> [--note <说明>] [--retry] [--prompt-file <文件>] | wait [--minutes 2] | stop <NNN> | result <NNN>')
      process.exitCode = 2
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
