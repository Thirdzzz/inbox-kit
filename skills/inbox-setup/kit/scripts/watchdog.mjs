// 看门狗：判断每个需求工作树里的开发子代理现在处于什么状态。
// 为什么：子代理可能超时、挂起或被上游错误打断，既不退出也不发完成通知；调度者只会被动等下去。
// 「活着」不能只看进程或注册表，必须有工作树里的真实动静作证。
// 状态：
//   parked        记录不是「进行中」（例如重试排队、待检查保留分支） → 不需要处理
//   launching     已认领，还没记下子代理（5 分钟内）       → 等
//   launch-failed 已认领超过 5 分钟仍没有子代理记录         → interrupt.mjs 后重派
//   live          进程在、最近有动静、没超时               → 等
//   exited        进程已结束且写下了退出码                 → launch.mjs result 读结果，走收尾
//   died          进程已不在却没有退出码（被杀、机器重启） → interrupt.mjs 后重派
//   stale         进程在，但超过空闲上限没有任何动静       → launch.mjs stop，再 interrupt.mjs
//   overdue       进程在，但运行超过时限                   → 同上，重派时要求缩小范围
// 用法：node .inbox/scripts/watchdog.mjs（输出 JSON）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { git, isMain, mainRoot, paths, readConfig } from './config.mjs'

export const launchWindowMinutes = 5

export function classify({ agentId, claimAgeMinutes, idleMinutes, runMinutes = 0, processAlive = true, exitCode = null, idleLimit = 15, timeLimit = Infinity }) {
  if (!agentId) return claimAgeMinutes < launchWindowMinutes ? 'launching' : 'launch-failed'
  if (!processAlive) return exitCode === null ? 'died' : 'exited'
  if (idleMinutes >= idleLimit) return 'stale'
  return runMinutes >= timeLimit ? 'overdue' : 'live'
}

const ignoredDirs = new Set(['node_modules', '.git'])

function newestMtime(dir, newest = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) newest = newestMtime(file, newest)
    else if (entry.isFile()) newest = Math.max(newest, statSync(file).mtimeMs)
  }
  return newest
}

export function processAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

// 动静 = 工作树文件、HEAD 日志、暂存区、子代理日志里最新的修改时间。
export function inspectWorktree(worktree, { now = Date.now(), idleLimit = 15, timeLimit = Infinity, isAlive = processAlive } = {}) {
  const gitDir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir')
  const file = (name) => path.join(gitDir, name)
  const agentId = existsSync(file('inbox-agent-id')) ? readFileSync(file('inbox-agent-id'), 'utf8').trim() : ''
  const exitText = existsSync(file('inbox-agent-exit')) ? readFileSync(file('inbox-agent-exit'), 'utf8').trim() : ''
  const exitCode = exitText === '' ? null : Number(exitText)
  const pid = Number(/^pid:(\d+)$/.exec(agentId)?.[1] ?? 0)
  const claimedAt = statSync(path.join(worktree, '.git')).mtimeMs
  const marks = [newestMtime(worktree), claimedAt]
  for (const name of ['index', 'logs/HEAD', 'inbox-agent-id', 'inbox-agent.log']) if (existsSync(file(name))) marks.push(statSync(file(name)).mtimeMs)
  const idleMinutes = Math.floor((now - Math.max(...marks)) / 60000)
  const claimAgeMinutes = Math.floor((now - claimedAt) / 60000)
  // 启动时间 = agent_id 文件的写入时间；重派时会重写，所以每次重试单独计时。
  const runMinutes = agentId ? Math.floor((now - statSync(file('inbox-agent-id')).mtimeMs) / 60000) : 0
  const alive = agentId ? isAlive(pid) : false
  return { agentId, exitCode, claimAgeMinutes, idleMinutes, runMinutes, state: classify({ agentId, claimAgeMinutes, idleMinutes, runMinutes, processAlive: alive, exitCode, idleLimit, timeLimit }) }
}

// 记录状态以主检出里的 inbox/NNN-*.md 为准：只有「进行中」的需求才有子代理要看。
export function recordStatuses(root) {
  const dir = path.join(root, paths.records)
  const map = new Map()
  if (!existsSync(dir)) return map
  for (const name of readdirSync(dir).filter((f) => /^\d{3}-.*\.md$/.test(f))) {
    map.set(name.slice(0, 3), /^status:\s*(\S+)/m.exec(readFileSync(path.join(dir, name), 'utf8'))?.[1] ?? '')
  }
  return map
}

export function inspectAll(root, { worktreeDir, now = Date.now(), idleLimit = 15, timeLimit = Infinity, isAlive = processAlive }) {
  const base = path.join(root, worktreeDir)
  if (!existsSync(base)) return []
  const statuses = recordStatuses(root)
  return readdirSync(base)
    .filter((name) => /^\d{3}$/.test(name))
    .map((id) => {
      const info = inspectWorktree(path.join(base, id), { now, idleLimit, timeLimit, isAlive })
      const status = statuses.get(id) ?? ''
      // 子代理还在跑时，不管记录写的是什么都要看着它；没在跑且记录不是「进行中」，就是停放的工作树。
      const parked = status !== '进行中' && !['live', 'stale', 'overdue'].includes(info.state)
      return { id, path: path.join(base, id), status, ...info, state: parked ? 'parked' : info.state }
    })
}

export const advice = {
  'launch-failed': (id) => `${id}：已认领但没有子代理记录，启动失败。运行 node .inbox/scripts/interrupt.mjs ${id} "启动失败" 后重派。`,
  died: (id) => `${id}：子代理进程已不在，也没有退出码（被杀或机器重启）。运行 node .inbox/scripts/interrupt.mjs ${id} "子代理进程消失" 后重派。`,
  exited: (id) => `${id}：子代理已结束。运行 node .inbox/scripts/launch.mjs result ${id} 读结果，再按调度技能收尾。`,
  stale: (id, s) => `${id}：子代理已 ${s.idleMinutes} 分钟没有任何动静，视为卡死。先 node .inbox/scripts/launch.mjs stop ${id}，再 node .inbox/scripts/interrupt.mjs ${id} "子代理卡死，${s.idleMinutes} 分钟无动静"，然后补位重派。`,
  overdue: (id, s) => `${id}：子代理已运行 ${s.runMinutes} 分钟，超过时限。先 node .inbox/scripts/launch.mjs stop ${id}，再 node .inbox/scripts/interrupt.mjs ${id} "超过运行时限"，重派时要求缩小范围、先提交检查点。`,
}

if (isMain(import.meta.url)) {
  const root = mainRoot()
  const config = readConfig(root)
  const results = inspectAll(root, { worktreeDir: config.worktreeDir, idleLimit: config.idleLimitMinutes, timeLimit: config.subagentTimeoutMinutes })
  console.log(JSON.stringify(results, null, 2))
  for (const s of results) if (advice[s.state]) console.error(advice[s.state](s.id, s))
}
