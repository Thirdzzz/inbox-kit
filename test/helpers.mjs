// 测试夹具：临时目录里的裸远端 + 主检出，用真实 git 和真实脚本跑。
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const KIT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skills/inbox-setup/kit')
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
delete env.GITHUB_REF_NAME
delete env.GITHUB_HEAD_REF
export const node = (cwd, script, ...args) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', env })

export function write(root, rel, content) {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
  writeFileSync(path.join(root, rel), content)
}

export const baseConfig = { projectName: '测试项目', commands: { check: 'true', fullCheck: 'test -f README.md' } }

// 返回 { root, remote, run(script,...args), cleanup }；root 已提交初始文件并推送到裸远端。
export function makeRepo({ config = baseConfig, render = true } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), 'inbox-kit-')))
  const remote = path.join(base, 'remote.git')
  const root = path.join(base, 'repo')
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', root])
  for (const [k, v] of [['user.name', 't'], ['user.email', 't@t'], ['commit.gpgsign', 'false']]) git(root, 'config', k, v)
  git(root, 'remote', 'add', 'origin', remote)
  write(root, 'README.md', '# 测试\n')
  if (config) write(root, 'inbox.config.json', `${JSON.stringify(config, null, 2)}\n`)
  git(root, 'add', '-A')
  git(root, 'commit', '-qm', 'init')
  git(root, 'push', '-q', '-u', 'origin', 'main')
  const run = (script, ...args) => node(root, path.join(root, '.inbox/scripts', script), ...args)
  if (render) {
    const result = node(root, path.join(KIT, 'scripts/render.mjs'), '--repo', root)
    if (result.status !== 0) throw new Error(result.stderr)
    execFileSync('git', ['-C', root, 'add', '-A'], { env })
    execFileSync('git', ['-C', root, 'commit', '-qm', 'install'], { env: { ...env, INBOX_ALLOW_MAIN_COMMIT: '1' } })
    git(root, 'push', '-q', 'origin', 'main')
  }
  return { base, root, remote, run, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

export const recordText = ({ id, title = '示例', status = '待办', retries = 0, depends = '[]', progress = [], question = '无' }) => `---
id: "${id}"
title: ${title}
type: 功能
autonomy: auto
forced_review_reason: ""
status: ${status}
branch: inbox/${id}
replies_seen: 0
auto_retries: ${retries}
preview: ""
depends_on: ${depends}
---

# ${id} ${title}

## 原始描述

示例。

## 验收标准

- 示例

## 追问

${question}

## 进展记录

${progress.map((line) => `- ${line}`).join('\n')}

## 结果

- 改了什么：
`
