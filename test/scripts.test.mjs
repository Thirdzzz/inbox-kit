// 单个脚本的行为：中断重试、状态检查、依赖、看门狗判定、通配、配置校验、决策日志。
import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { KIT, recordText } from './helpers.mjs'

const load = (name) => import(path.join(KIT, 'scripts', name))

test('配置：缺检查命令、非法取值都被拒绝，并说明怎么改', async () => {
  const { normalize } = await load('config.mjs')
  assert.deepEqual(normalize({ commands: { check: 'a', fullCheck: 'b' } }).errors, [])
  const { errors } = normalize({ deploy: { mode: 'vercel' }, dev: { runtime: 'claude' }, slots: 0 })
  assert.ok(errors.some((e) => e.includes('commands.check')))
  assert.ok(errors.some((e) => e.includes('deploy.mode')))
  assert.ok(errors.some((e) => e.includes('dev.runtime')))
  assert.ok(errors.some((e) => e.includes('slots')))
  assert.ok(normalize({ commands: { check: 'a', fullCheck: 'b' }, dev: { runtime: 'custom', command: 'x' } }).errors.some((e) => e.includes('{prompt_file}')))
})

test('通配：** 跨目录，* 只在一段内', async () => {
  const { matchesAny } = await load('config.mjs')
  assert.ok(matchesAny('src/db/schema.ts', ['src/db/**']))
  assert.ok(matchesAny('migrations/001.sql', ['**/*.sql']))
  assert.ok(matchesAny('a/b/migrations/1.sql', ['**/migrations/*.sql']))
  assert.ok(!matchesAny('src/dbx.ts', ['src/db/**']))
  assert.ok(!matchesAny('docs/a/b.md', ['docs/*.md']))
})

test('中断：额度内改回待办并计数，用尽后才标失败', async () => {
  const { interruptText } = await load('interrupt.mjs')
  const inbox = '前言\n<!-- ===== 需求区（从这里往下写） ===== -->\n## [007 · 进行中] 示例\n详情：[x](x)\n说明：旧说明\n> 回复：好\n'
  let record = recordText({ id: '007', status: '进行中' })
  for (let attempt = 1; attempt <= 3; attempt++) {
    const out = interruptText({ inbox, record, id: '007', reason: '超时', date: '2026-01-01', maxAutoRetries: 3 })
    assert.match(out.record, /^status: 待办$/m)
    assert.match(out.record, new RegExp(`^auto_retries: ${attempt}$`, 'm'))
    assert.match(out.inbox, new RegExp(`## \\[007 · 待办\\] 示例\\n详情：\\[x\\]\\(x\\)\\n说明：子代理中断（超时），已自动重试 ${attempt}/3`))
    assert.match(out.inbox, /> 回复：好/)
    record = out.record.replace('status: 待办', 'status: 进行中')
  }
  const last = interruptText({ inbox, record, id: '007', reason: '超时', date: '2026-01-01', maxAutoRetries: 3 })
  assert.match(last.record, /^status: 失败$/m)
  assert.match(last.inbox, /## \[007 · 失败\]/)
  const noRetry = interruptText({ inbox, record: recordText({ id: '007', status: '进行中' }), id: '007', reason: '部署失败已回滚', date: 'd', retry: false })
  assert.match(noRetry.record, /不再自动重试/)
  assert.throws(() => interruptText({ inbox, record, id: '007', reason: ' ', date: 'd' }), /原因/)
  const punct = interruptText({ inbox, record: recordText({ id: '007', status: '进行中' }), id: '007', reason: '推送失败。', date: 'd' })
  assert.doesNotMatch(punct.record, /。。/)
})

test('状态检查：静默改回待办、过早失败、无标签追问、未知状态、超额计数都被拒绝', async () => {
  const { findStatusProblems, parseRecord } = await load('check-status.mjs')
  const records = [
    parseRecord('001-a.md', recordText({ id: '001', status: '待办', progress: ['2026 · 调度者 · 中断：超时'] })),
    parseRecord('002-b.md', recordText({ id: '002', status: '失败', retries: 1, progress: ['2026 · 调度者 · 中断：超时'] })),
    parseRecord('003-c.md', recordText({ id: '003', status: '需要补充', question: '按钮放哪？' })),
    parseRecord('004-d.md', recordText({ id: '004', status: '完成' })),
    parseRecord('005-e.md', recordText({ id: '005', status: '待办', retries: 4 })),
    parseRecord('006-f.md', recordText({ id: '006', status: '需要补充', question: '- [凭据] 需要支付密钥' })),
    parseRecord('007-g.md', recordText({ id: '007', status: '待办', retries: 1, progress: ['2026 · 调度者 · 中断（自动重试 1/3）：超时'] })),
    parseRecord('008-h.md', recordText({ id: '008', status: '失败', progress: ['x · 中断：部署失败。重试无济于事，不再自动重试'] })),
  ]
  const problems = findStatusProblems(records, { maxAutoRetries: 3 })
  for (const id of ['001', '002', '003', '004', '005']) assert.ok(problems.some((p) => p.startsWith(id)), `${id} 应被拒绝`)
  for (const id of ['006', '007', '008']) assert.ok(!problems.some((p) => p.startsWith(id)), `${id} 不应被拒绝`)
  assert.ok(problems.every((p) => /interrupt\.mjs|假设|改成|不要手工/.test(p)), '每条错误都要给出修法')
})

test('依赖：缺失和循环被拒绝，未上线的依赖列为阻碍', async () => {
  const { validateDependencies, parseDependencies } = await load('dependencies.mjs')
  assert.deepEqual(parseDependencies('["001", "002"]'), ['001', '002'])
  assert.deepEqual(parseDependencies('""'), [])
  assert.throws(() => parseDependencies('[1]'), /无效/)
  const ok = validateDependencies([
    { id: '001', status: '已上线', dependsOn: [] },
    { id: '002', status: '待办', dependsOn: [] },
    { id: '003', status: '待办', dependsOn: ['001', '002'] },
  ])
  assert.deepEqual(ok.find((r) => r.id === '003').blockers, [{ id: '002', status: '待办' }])
  assert.throws(() => validateDependencies([{ id: '001', status: '待办', dependsOn: ['009'] }]), /找不到/)
  assert.throws(() => validateDependencies([{ id: '001', status: '待办', dependsOn: ['002'] }, { id: '002', status: '待办', dependsOn: ['001'] }]), /循环/)
})

test('看门狗判定：启动窗口、进程消失、正常结束、卡死、超时', async () => {
  const { classify } = await load('watchdog.mjs')
  // 退出码优先：进程号被复用、看起来「活着」，只要写下了退出码就是结束了。
  assert.equal(classify({ agentId: 'pid:1@x', processAlive: true, exitCode: 0, idleMinutes: 99 }), 'exited')
  assert.equal(classify({ agentId: '', claimAgeMinutes: 2 }), 'launching')
  assert.equal(classify({ agentId: '', claimAgeMinutes: 6 }), 'launch-failed')
  assert.equal(classify({ agentId: 'pid:1', processAlive: false, exitCode: null }), 'died')
  assert.equal(classify({ agentId: 'pid:1', processAlive: false, exitCode: 0 }), 'exited')
  assert.equal(classify({ agentId: 'pid:1', idleMinutes: 15, idleLimit: 15 }), 'stale')
  assert.equal(classify({ agentId: 'pid:1', idleMinutes: 1, runMinutes: 31, timeLimit: 30 }), 'overdue')
  assert.equal(classify({ agentId: 'pid:1', idleMinutes: 1, runMinutes: 10, timeLimit: 30 }), 'live')
})

test('子代理命令：codex 在工作树里以完全访问运行，pi 用无头模式，自定义命令替换占位符', async () => {
  const { agentCommand } = await load('launch.mjs')
  const files = { worktree: "/w/it's", promptFile: '/p', lastFile: '/l' }
  const codex = agentCommand({ runtime: 'codex', model: 'gpt-x' }, files)
  assert.match(codex, /^codex exec --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check -C '\/w\/it'\\''s' -o '\/l' -m 'gpt-x' "\$\(cat '\/p'\)" < \/dev\/null$/)
  const pi = agentCommand({ runtime: 'pi', model: '' }, files)
  assert.match(pi, /^pi --mode json -p --no-session "\$\(cat '\/p'\)" < \/dev\/null$/)
  assert.doesNotMatch(pi, /--approve|\| *tee/, 'pi 不能信任工作树里的扩展，也不能用管道吞掉退出码')
  assert.equal(agentCommand({ runtime: 'custom', command: 'agent --in {prompt_file} --cwd {worktree}' }, files), "agent --in '/p' --cwd '/w/it'\\''s'")
})

test('决策日志：五个字段、不能换行、公式开头加单引号', async () => {
  const { buildRow } = await load('log-decision.mjs')
  assert.equal(buildRow(['阶段', '=决策', '原因', '证据', '结果'], 'T'), "T\t阶段\t'=决策\t原因\t证据\t结果\n")
  assert.throws(() => buildRow(['a', 'b', 'c', 'd']), /需要恰好 5 个参数，收到 4 个/)
  assert.throws(() => buildRow(['a', 'b\nc', 'c', 'd', 'e']), /换行/)
})

test('部署确认：GitHub 状态和检查运行合成一个结论', async () => {
  const { combine } = await load('deploy-status.mjs')
  assert.equal(combine({ statusState: 'pending', statuses: [], checkRuns: [] }), 'pending')
  assert.equal(combine({ statusState: 'success', statuses: [{}], checkRuns: [{ status: 'completed', conclusion: 'success' }] }), 'success')
  assert.equal(combine({ statusState: 'pending', statuses: [], checkRuns: [{ status: 'completed', conclusion: 'failure' }] }), 'failure')
  assert.equal(combine({ statusState: 'pending', statuses: [{}], checkRuns: [] }), 'pending')
  assert.equal(combine({ statusState: 'failure', statuses: [{}], checkRuns: [] }), 'failure')
})

test('模板填充：条件段、反向段、嵌套、缺变量报错', async () => {
  const { fill } = await load('render.mjs')
  assert.equal(fill('a {{#x}}X{{/x}}{{^x}}Y{{/x}} {{v}}', { x: false, v: 1 }), 'a Y 1')
  assert.throws(() => fill('{{nope}}', {}), /未定义/)
  assert.throws(() => fill('{{#a}}x', { a: 1 }), /没有配对/)
})

test('通过软链接运行脚本也能执行（技能常以软链接安装）', async () => {
  const { symlinkSync, mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const dir = mkdtempSync(path.join(tmpdir(), 'inbox-link-'))
  try {
    symlinkSync(path.resolve(KIT, '..'), path.join(dir, 'inbox-setup'))
    const result = spawnSync(process.execPath, [path.join(dir, 'inbox-setup/kit/scripts/detect.mjs'), '--repo', path.resolve(KIT, '../../..')], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"suggested"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('进程身份：启动时间对不上就不算我们的进程（防进程号复用误杀）', async () => {
  const { formatAgentId, isOurProcess, parseAgentId, startTimeOf } = await load('process.mjs')
  const started = startTimeOf(process.pid)
  assert.ok(started)
  assert.equal(isOurProcess(formatAgentId(process.pid, started)), true)
  assert.equal(isOurProcess(formatAgentId(process.pid, 'Mon Jan  1 00:00:00 2001')), false)
  assert.equal(isOurProcess(`pid:${process.pid}`), false, '没有启动时间的旧格式无法核对身份')
  assert.deepEqual(parseAgentId('pid:12@Sat Nov 14 00:54:33 2026'), { pid: 12, started: 'Sat Nov 14 00:54:33 2026' })
})

test('pi 的最终回复从 JSON 事件里取', async () => {
  const { piLastMessage } = await load('launch.mjs')
  const log = ['{"type":"agent_start"}', JSON.stringify({ type: 'agent_end', messages: [{ role: 'user', content: [] }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '返回：ready' }] }] }), '{"type":"agent_settled"}'].join('\n')
  assert.equal(piLastMessage(log), '返回：ready')
})

test('越权规则：需求分支不能改流水线自身', async () => {
  const { findOwnershipViolations } = await load('check-ownership.mjs')
  const changed = ['src/a.js', 'inbox/results/009.md', 'inbox.config.json', '.inbox/scripts/integrate.mjs', '.agents/skills/inbox/SKILL.md', '.agents/skills/other/SKILL.md']
  assert.deepEqual(findOwnershipViolations({ branch: 'inbox/009', changedFiles: changed }), ['inbox.config.json', '.inbox/scripts/integrate.mjs', '.agents/skills/inbox/SKILL.md'])
  // 编号早于 enforceFrom 时放过状态文件，但流水线自身仍然不行。
  assert.deepEqual(findOwnershipViolations({ branch: 'inbox/009', changedFiles: ['INBOX.md', 'inbox.config.json'], enforceFrom: 10 }), ['inbox.config.json'])
})

test('状态检查：记录在 INBOX.md 里没有编号标题、或标题状态不一致都报错（Codex 验收中 005 漏了前缀）', async () => {
  const { findHeadingProblems } = await load('check-status.mjs')
  const marker = '<!-- ===== 需求区（从这里往下写） ===== -->'
  const inbox = `# 收件箱\n${marker}\n\n## 清单标题行\n描述\n\n## [006 · 待检查] 创建时间\n`
  const problems = findHeadingProblems(inbox, [{ file: '005-清单标题行.md', status: '已上线' }, { file: '006-创建时间.md', status: '已上线' }])
  assert.equal(problems.length, 2)
  assert.match(problems[0], /找不到「## \[005 · 已上线\]」标题/)
  assert.match(problems[1], /006 的标题写「待检查」，记录 006-创建时间\.md 是「已上线」/)
  assert.deepEqual(findHeadingProblems(`${marker}\n## [005 · 已上线] 清单标题行\n`, [{ file: '005-x.md', status: '已上线' }]), [])
})
