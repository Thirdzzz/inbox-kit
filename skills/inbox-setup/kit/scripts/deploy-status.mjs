// 确认某个提交的部署结果。每 20 秒查一次，默认最多 2 分钟（调度者的命令工具常有单条超时，需要更久就重复调用）。
// deploy.verify = github-status：读 GitHub 上该提交的状态（commit status）与检查运行（check runs），需要已登录的 gh。
// deploy.verify = command：运行 deploy.verifyCommand（{sha} 换成提交号）；退出码 0 成功，1 失败，其他视为还没结果。
// 用法（主检出）：node .inbox/scripts/deploy-status.mjs <sha> [--timeout-minutes 2] [--interval-seconds 20]
// 退出码：0 成功；1 失败；3 超时（没有结论）。
import { spawnSync } from 'node:child_process'
import { argValue, isMain, mainRoot, readConfig } from './config.mjs'

// 把 GitHub 的两类结果合成一个结论：任一失败即失败；全部完成且至少有一项成功才算成功；其余为等待中。
export function combine({ statusState, statuses = [], checkRuns = [] }) {
  const bad = ['failure', 'error', 'cancelled', 'timed_out', 'action_required', 'startup_failure']
  if (statusState === 'failure' || statusState === 'error' || checkRuns.some((run) => bad.includes(run.conclusion))) return 'failure'
  const statusDone = statuses.length === 0 || statusState === 'success'
  const runsDone = checkRuns.every((run) => run.status === 'completed')
  if (statuses.length + checkRuns.length === 0) return 'pending'
  return statusDone && runsDone ? 'success' : 'pending'
}

function githubOnce(cwd, sha) {
  const gh = (...args) => spawnSync('gh', args, { cwd, encoding: 'utf8' })
  const repo = gh('repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner').stdout.trim()
  if (!repo) return { state: 'pending', detail: 'gh 无法识别仓库（未登录或没有 GitHub 远端）' }
  const status = JSON.parse(gh('api', `repos/${repo}/commits/${sha}/status`).stdout || '{}')
  const runs = JSON.parse(gh('api', `repos/${repo}/commits/${sha}/check-runs`).stdout || '{}')
  return { state: combine({ statusState: status.state, statuses: status.statuses ?? [], checkRuns: runs.check_runs ?? [] }), detail: repo }
}

function commandOnce(cwd, command, sha) {
  const result = spawnSync('sh', ['-c', command.replaceAll('{sha}', sha)], { cwd, encoding: 'utf8' })
  return { state: result.status === 0 ? 'success' : result.status === 1 ? 'failure' : 'pending', detail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(-500) }
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2)
  const sha = args[0]
  const root = mainRoot()
  const config = readConfig(root)
  const timeout = Number(argValue(args, '--timeout-minutes') ?? 2) * 60000
  if (!sha) {
    console.error('用法：deploy-status.mjs <sha>')
    process.exit(2)
  }
  if (config.deploy.verify === 'none') {
    console.log('配置里没有部署确认方式（deploy.verify = none）。')
    process.exit(3)
  }
  const deadline = Date.now() + timeout
  for (;;) {
    const { state, detail } = config.deploy.verify === 'github-status' ? githubOnce(root, sha) : commandOnce(root, config.deploy.verifyCommand, sha)
    if (state === 'success' || state === 'failure') {
      console.log(`部署${state === 'success' ? '成功' : '失败'}：${sha}${detail ? `（${detail}）` : ''}`)
      process.exit(state === 'success' ? 0 : 1)
    }
    if (Date.now() >= deadline) {
      console.log(`部署在 ${timeout / 60000} 分钟内没有结论：${sha}${detail ? `（${detail}）` : ''}`)
      process.exit(3)
    }
    spawnSync('sleep', [String(argValue(args, '--interval-seconds') ?? 20)])
  }
}
