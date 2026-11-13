// 开发子代理的启动、等待、停止与结果读取。子代理是一个独立进程，工作目录就是需求工作树：
// pi 与 Codex 的原生子代理都和调度者共用目录、也不保证发完成通知，所以统一用进程，由看门狗按真实动静判断死活。
// 运行文件都放在该工作树私有的 git 目录里（不进版本库，随工作树删除）：
//   inbox-agent-id（pid:<进程号>） inbox-agent.log（全部输出） inbox-agent-last.txt（最终回复） inbox-agent-exit（退出码）
// 用法：
//   node .inbox/scripts/launch.mjs start <NNN> [--note "<附加说明>"]   用 brief.mjs 生成任务说明并启动，立即返回
//   node .inbox/scripts/launch.mjs start <NNN> --prompt-file <文件>      用自备的任务说明启动
//   node .inbox/scripts/launch.mjs wait [--minutes 10]                等到任一子代理结束或卡死，最多等这么久，输出看门狗 JSON
//   node .inbox/scripts/launch.mjs stop <NNN>                          停掉子代理（整个进程组）
//   node .inbox/scripts/launch.mjs result <NNN>                        输出退出码、最终回复和结果文件里的「返回：」
import { spawn } from 'node:child_process'
import { existsSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { argValue, git, isMain, mainRoot, paths, readConfig } from './config.mjs'
import { advice, inspectAll } from './watchdog.mjs'
import { buildBrief } from './brief.mjs'

export const runFile = (worktree, name) => git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', name)

const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`

// 返回要交给 sh -c 的命令。提示词一律从文件读，避免命令行转义问题。
export function agentCommand(dev, { worktree, promptFile, lastFile }) {
  const model = dev.model ? ` ${dev.runtime === 'codex' ? '-m' : '--model'} ${quote(dev.model)}` : ''
  if (dev.runtime === 'codex') {
    // 子代理要写 .git（提交、推送）并联网，Codex 的工作区沙箱都会拦，所以按完全访问运行；它只在自己的工作树里工作。
    return `codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C ${quote(worktree)} -o ${quote(lastFile)}${model} "$(cat ${quote(promptFile)})" < /dev/null`
  }
  if (dev.runtime === 'pi') {
    return `pi -p --approve${model} "$(cat ${quote(promptFile)})" < /dev/null | tee ${quote(lastFile)}`
  }
  return dev.command.replaceAll('{prompt_file}', quote(promptFile)).replaceAll('{worktree}', quote(worktree)).replaceAll('{last_message}', quote(lastFile))
}

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export const pidOf = (agentId) => Number(/^pid:(\d+)$/.exec(agentId ?? '')?.[1] ?? 0)

export function start(root, config, id, { promptFile, note = '' } = {}) {
  const worktree = path.join(root, config.worktreeDir, id)
  if (!existsSync(worktree)) throw new Error(`没有工作树 ${worktree}；先运行 node .inbox/scripts/worktree.mjs claim ${id}`)
  const idFile = runFile(worktree, 'inbox-agent-id')
  if (existsSync(idFile)) {
    const pid = pidOf(readFileSync(idFile, 'utf8').trim())
    if (pid && alive(pid)) throw new Error(`${id} 已有子代理在运行（pid ${pid}）；先 stop 再重派`)
  }
  // 记录必须先标「进行中」：看门狗只盯「进行中」的需求，没标就启动的子代理结束后没人收尾。
  const records = readdirSync(path.join(root, paths.records)).filter((name) => name.startsWith(`${id}-`) && name.endsWith('.md'))
  if (records.length !== 1) throw new Error(`inbox/ 中应恰好有一个 ${id}-*.md，实际 ${records.length} 个`)
  const record = records[0]
  const status = /^status:\s*(\S+)/m.exec(readFileSync(path.join(root, paths.records, record), 'utf8'))?.[1]
  if (status !== '进行中') throw new Error(`${id} 的记录状态是「${status}」。先把记录和 INBOX.md 标题改成「进行中」并提交，再启动子代理。`)
  const saved = runFile(worktree, 'inbox-agent-prompt.md')
  if (promptFile) {
    const prompt = path.resolve(promptFile)
    if (!existsSync(prompt)) throw new Error(`找不到提示词文件 ${prompt}`)
    writeFileSync(saved, readFileSync(prompt, 'utf8'))
  } else writeFileSync(saved, buildBrief(config, { id, worktree, recordFile: `${paths.records}/${record}`, note }))
  const lastFile = runFile(worktree, 'inbox-agent-last.txt')
  const exitFile = runFile(worktree, 'inbox-agent-exit')
  for (const file of [lastFile, exitFile]) rmSync(file, { force: true })
  const log = openSync(runFile(worktree, 'inbox-agent.log'), 'a')
  const command = agentCommand(config.dev, { worktree, promptFile: saved, lastFile })
  // 外层 sh 记下退出码；detached 让子代理自成进程组，调度者结束也不会带走它，stop 时整组停掉。
  const child = spawn('sh', ['-c', `${command}\necho $? > ${quote(exitFile)}`], { cwd: worktree, detached: true, stdio: ['ignore', log, log], env: { ...process.env, INBOX_REQUIREMENT: id } })
  child.unref()
  writeFileSync(idFile, `pid:${child.pid}\n`)
  return { id, pid: child.pid, worktree, runtime: config.dev.runtime, log: runFile(worktree, 'inbox-agent.log') }
}

export function stop(root, config, id) {
  const worktree = path.join(root, config.worktreeDir, id)
  const idFile = runFile(worktree, 'inbox-agent-id')
  const pid = existsSync(idFile) ? pidOf(readFileSync(idFile, 'utf8').trim()) : 0
  if (!pid || !alive(pid)) return `${id}：没有在运行的子代理`
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    process.kill(pid, 'SIGTERM')
  }
  return `${id}：已停止子代理（pid ${pid}）`
}

export function result(root, config, id) {
  const worktree = path.join(root, config.worktreeDir, id)
  const read = (name) => {
    const file = runFile(worktree, name)
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }
  const exitText = read('inbox-agent-exit').trim()
  const resultsFile = path.join(worktree, paths.results, `${id}.md`)
  const results = existsSync(resultsFile) ? readFileSync(resultsFile, 'utf8') : ''
  const declared = /^返回[：:]\s*(ready|needs-info|failed)\b/m.exec(results)?.[1] ?? ''
  return {
    id,
    exitCode: exitText === '' ? null : Number(exitText),
    returned: declared || null,
    resultsFile: results ? path.relative(root, resultsFile) : null,
    lastMessage: read('inbox-agent-last.txt').trim().slice(-3000),
    logTail: read('inbox-agent.log').trim().split('\n').slice(-20).join('\n'),
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 有界等待：任一子代理结束（exited/died）或被判卡死、超时，就返回，交给调度者处理；没有在跑的子代理时立即返回。
export async function wait(root, config, { minutes = 10, pollSeconds = 15 } = {}) {
  let delay = 1
  const deadline = Date.now() + minutes * 60000
  const options = { worktreeDir: config.worktreeDir, idleLimit: config.idleLimitMinutes, timeLimit: config.subagentTimeoutMinutes }
  for (;;) {
    const states = inspectAll(root, options)
    const running = states.filter((s) => s.state === 'live' || s.state === 'launching')
    const needsAction = states.filter((s) => !running.includes(s) && s.state !== 'parked')
    if (needsAction.length || !running.length) return { timedOut: false, states, needsAction: needsAction.map((s) => ({ id: s.id, state: s.state, advice: advice[s.state]?.(s.id, s) })) }
    if (Date.now() >= deadline) return { timedOut: true, states, needsAction: [] }
    await sleep(delay * 1000)
    delay = Math.min(delay * 2, pollSeconds)
  }
}

if (isMain(import.meta.url)) {
  const [command, id] = process.argv.slice(2)
  const args = process.argv.slice(2)
  try {
    const root = mainRoot()
    const config = readConfig(root)
    if (command === 'start') console.log(JSON.stringify(start(root, config, id, { promptFile: argValue(args, '--prompt-file'), note: argValue(args, '--note') ?? '' }), null, 2))
    else if (command === 'stop') console.log(stop(root, config, id))
    else if (command === 'result') console.log(JSON.stringify(result(root, config, id), null, 2))
    else if (command === 'wait') console.log(JSON.stringify(await wait(root, config, { minutes: Number(argValue(args, '--minutes') ?? 10) }), null, 2))
    else {
      console.error('用法：launch.mjs start <NNN> [--note <说明> | --prompt-file <文件>] | wait [--minutes 10] | stop <NNN> | result <NNN>')
      process.exitCode = 2
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
