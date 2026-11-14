// 收件箱状态锁：同一台机器上所有检出共用一把（放在公共 Git 目录里）。
// 为什么：两个调度会话同时在主检出里同步状态时，会抢 Git 的暂存区（index.lock），一方提交失败；
// 更糟的是一方「提交、变基、推送」的中间被另一方插入。锁把整段同步串起来。
// 只有持有者进程已不在才算遗留锁；不按持有时长接管，否则活着的持有者会和接管者同时在锁内。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function holderAlive(owner) {
  if (!owner?.pid) return false
  try {
    process.kill(owner.pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

export function lockPath(cwd) {
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim()
  return path.join(common, 'inbox-state.lock')
}

// 拿到锁后执行 fn；等待超过 waitMs 抛错（错误信息以「等收件箱状态锁超时」开头）。
export function withStateLock(cwd, fn, { waitMs = 120000, label = '' } = {}) {
  const lock = lockPath(cwd)
  const token = `${process.pid}-${Date.now()}-${Math.random()}`
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      mkdirSync(lock)
      writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now(), label, token }))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try {
        owner = JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8'))
      } catch {
        // 目录刚建好、还没写 owner.json：5 秒内当作有人持有，之后当作遗留。
        try {
          owner = { pid: Date.now() - statSync(lock).mtimeMs < 5000 ? -1 : 0 }
        } catch {
          continue
        }
      }
      if (owner.pid !== -1 && !holderAlive(owner)) {
        try {
          const grave = `${lock}.stale-${process.pid}-${Date.now()}`
          renameSync(lock, grave)
          rmSync(grave, { recursive: true, force: true })
        } catch {}
        continue
      }
      if (Date.now() > deadline) throw new Error(`等收件箱状态锁超时（持有者 pid ${owner.pid}，${owner.label ?? ''}）`)
      sleep(150)
    }
  }
  try {
    return fn()
  } finally {
    // 只删自己的锁。
    try {
      if (JSON.parse(readFileSync(path.join(lock, 'owner.json'), 'utf8')).token === token) rmSync(lock, { recursive: true, force: true })
    } catch {}
  }
}
