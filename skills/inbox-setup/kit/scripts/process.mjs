// 子代理进程的身份核对。只记进程号不够：机器重启或进程结束后进程号会被复用，按旧进程号停进程会误杀无关进程。
// 所以启动时同时记下进程的启动时间，之后每次判断存活、每次停止前都核对一遍。
import { spawnSync } from 'node:child_process'

// 进程启动时间（ps 的 lstart，本机时区的固定格式字符串）；进程不存在时返回空串。
export function startTimeOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return ''
  const result = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim().replace(/\s+/g, ' ') : ''
}

// agent id 格式：pid:<进程号>@<启动时间>。旧格式 pid:<进程号> 视为无法核对身份。
export function parseAgentId(agentId) {
  const match = /^pid:(\d+)(?:@(.+))?$/.exec(agentId ?? '')
  return match ? { pid: Number(match[1]), started: match[2] ?? '' } : { pid: 0, started: '' }
}

export const formatAgentId = (pid, started) => `pid:${pid}@${started}`

// 是不是我们启动的那个进程，而且还在跑。
export function isOurProcess(agentId, startTime = startTimeOf) {
  const { pid, started } = parseAgentId(agentId)
  if (!pid || !started) return false
  return startTime(pid) === started
}

// 停掉子代理所在的整个进程组（子代理启动的开发服务器、监听进程也在组里）。进程组号等于启动时的进程号。
export function killGroup(pid, signal = 'SIGTERM') {
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

// 进程组里是否还有进程（子代理已退出，但它启动的后台进程可能还在）。
export function groupAlive(pid) {
  const result = spawnSync('ps', ['-o', 'pid=', '-g', String(pid)], { encoding: 'utf8' })
  return result.status === 0 && result.stdout.trim() !== ''
}
