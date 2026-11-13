// 看门狗：判断每条需求的开发子代理现在处于什么状态。
// 为什么：子代理可能超时、挂起或被上游错误打断，既不退出也不发完成通知；调度者只会被动等下去。
// 「活着」不能只看进程，必须有真实动静作证；进程身份要核对启动时间，防止进程号复用造成误判或误杀。
// 状态：
//   parked        记录不是「进行中」，工作树只是保留着（如待检查、重试排队） → 不需要处理
//   launching     已认领，还没记下子代理（5 分钟内）                      → 等
//   live          子代理在跑、最近有动静、没超时                          → 等
//   exited        子代理已结束并写下了退出码                              → launch.mjs result 读结果，走收尾
//   died          子代理已不在却没有退出码（被杀、机器重启）              → interrupt.mjs 后重派
//   launch-failed 已认领超过 5 分钟仍没有子代理记录                       → interrupt.mjs 后重派
//   stale         子代理还在，但超过空闲上限没有任何动静                  → launch.mjs stop，再 interrupt.mjs
//   overdue       子代理还在，但运行超过时限                              → 同上，重派时要求缩小范围
//   orphan        记录是「进行中」，却没有工作树                          → interrupt.mjs 后重派
//   broken        工作树残缺，读不出状态                                  → worktree.mjs cleanup 后 interrupt.mjs
// 用法：node .inbox/scripts/watchdog.mjs（输出 JSON）
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { git, isMain, mainRoot, paths, readConfig, worktreeBase } from './config.mjs'
import { isOurProcess } from './process.mjs'

export const launchWindowMinutes = 5

// 先看退出码：写下了退出码就是结束了，不管进程号现在被谁占着。
export function classify({ agentId, claimAgeMinutes, idleMinutes, runMinutes = 0, processAlive = true, exitCode = null, idleLimit = 15, timeLimit = Infinity }) {
  if (!agentId) return claimAgeMinutes < launchWindowMinutes ? 'launching' : 'launch-failed'
  if (exitCode !== null) return 'exited'
  if (!processAlive) return 'died'
  if (idleMinutes >= idleLimit) return 'stale'
  return runMinutes >= timeLimit ? 'overdue' : 'live'
}

const ignoredDirs = new Set(['node_modules', '.git'])

function newestMtime(dir, newest = 0) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirs.has(entry.name)) continue
    const file = path.join(dir, entry.name)
    try {
      if (entry.isDirectory()) newest = newestMtime(file, newest)
      else if (entry.isFile()) newest = Math.max(newest, statSync(file).mtimeMs)
    } catch {}
  }
  return newest
}

// 动静 = 工作树文件、HEAD 日志、暂存区、子代理日志里最新的修改时间。
export function inspectWorktree(worktree, { now = Date.now(), idleLimit = 15, timeLimit = Infinity, isAlive = isOurProcess } = {}) {
  const gitDir = git(worktree, 'rev-parse', '--path-format=absolute', '--git-dir')
  const file = (name) => path.join(gitDir, name)
  const agentId = existsSync(file('inbox-agent-id')) ? readFileSync(file('inbox-agent-id'), 'utf8').trim() : ''
  const exitText = existsSync(file('inbox-agent-exit')) ? readFileSync(file('inbox-agent-exit'), 'utf8').trim() : ''
  const exitCode = exitText === '' ? null : Number(exitText)
  const claimedAt = statSync(path.join(worktree, '.git')).mtimeMs
  const marks = [newestMtime(worktree), claimedAt]
  for (const name of ['index', 'logs/HEAD', 'inbox-agent-id', 'inbox-agent.log']) if (existsSync(file(name))) marks.push(statSync(file(name)).mtimeMs)
  const idleMinutes = Math.floor((now - Math.max(...marks)) / 60000)
  const claimAgeMinutes = Math.floor((now - claimedAt) / 60000)
  // 启动时间 = agent id 文件的写入时间；重派时会重写，所以每次重试单独计时。
  const runMinutes = agentId ? Math.floor((now - statSync(file('inbox-agent-id')).mtimeMs) / 60000) : 0
  const alive = agentId ? isAlive(agentId) : false
  return { agentId, exitCode, claimAgeMinutes, idleMinutes, runMinutes, state: classify({ agentId, claimAgeMinutes, idleMinutes, runMinutes, processAlive: alive, exitCode, idleLimit, timeLimit }) }
}

// 记录状态以主检出里的 inbox/NNN-*.md 为准。
export function recordStatuses(root) {
  const dir = path.join(root, paths.records)
  const map = new Map()
  if (!existsSync(dir)) return map
  for (const name of readdirSync(dir).filter((f) => /^\d{3}-.*\.md$/.test(f))) {
    map.set(name.slice(0, 3), /^status:\s*(\S+)/m.exec(readFileSync(path.join(dir, name), 'utf8'))?.[1] ?? '')
  }
  return map
}

export function inspectAll(root, config, { now = Date.now(), idleLimit = 15, timeLimit = Infinity, isAlive = isOurProcess } = {}) {
  const base = worktreeBase(root, config)
  const statuses = recordStatuses(root)
  const ids = existsSync(base) ? readdirSync(base).filter((name) => /^\d{3}$/.test(name)) : []
  const results = ids.map((id) => {
    const dir = path.join(base, id)
    const status = statuses.get(id) ?? ''
    let info
    try {
      info = inspectWorktree(dir, { now, idleLimit, timeLimit, isAlive })
    } catch (error) {
      return { id, path: dir, status, state: 'broken', error: error.message.split('\n')[0] }
    }
    // 子代理还在跑时，不管记录写的是什么都要看着它；没在跑且记录不是「进行中」，就是停放的工作树。
    const parked = status !== '进行中' && !['live', 'stale', 'overdue'].includes(info.state)
    return { id, path: dir, status, ...info, state: parked ? 'parked' : info.state }
  })
  for (const [id, status] of statuses) if (status === '进行中' && !ids.includes(id)) results.push({ id, path: path.join(base, id), status, state: 'orphan' })
  return results.sort((a, b) => a.id.localeCompare(b.id))
}

const interrupt = (id, reason) => `node .inbox/scripts/interrupt.mjs ${id} "${reason}"`
export const advice = {
  'launch-failed': (id) => `${id}：已认领但没有子代理记录，启动失败。运行 ${interrupt(id, '启动失败')}，再按调度技能重派。`,
  died: (id) => `${id}：子代理进程已不在，也没有退出码（被杀或机器重启）。运行 ${interrupt(id, '子代理进程消失')}，再重派。`,
  exited: (id) => `${id}：子代理已结束。运行 node .inbox/scripts/launch.mjs result ${id} 读结果，再按调度技能收尾。`,
  stale: (id, s) => `${id}：子代理已 ${s.idleMinutes} 分钟没有任何动静，视为卡死。先 node .inbox/scripts/launch.mjs stop ${id}，再 ${interrupt(id, `子代理卡死，${s.idleMinutes} 分钟无动静`)}，然后补位重派。`,
  overdue: (id, s) => `${id}：子代理已运行 ${s.runMinutes} 分钟，超过时限。先 node .inbox/scripts/launch.mjs stop ${id}，再 ${interrupt(id, '超过运行时限')}，重派时要求缩小范围、先提交检查点。`,
  orphan: (id) => `${id}：记录是「进行中」，却没有工作树。运行 ${interrupt(id, '工作树丢失')}，再重派（认领时会接管已推送的分支）。`,
  broken: (id, s) => `${id}：工作树残缺（${s.error}）。运行 node .inbox/scripts/worktree.mjs cleanup ${id} --keep-branch，再 ${interrupt(id, '工作树残缺')}。`,
}

if (isMain(import.meta.url)) {
  const root = mainRoot()
  const config = readConfig(root)
  const results = inspectAll(root, config, { idleLimit: config.idleLimitMinutes, timeLimit: config.subagentTimeoutMinutes })
  console.log(JSON.stringify(results, null, 2))
  for (const s of results) if (advice[s.state]) console.error(advice[s.state](s.id, s))
}
