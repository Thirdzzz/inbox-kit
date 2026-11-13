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
  assert.match(agentCommand({ runtime: 'pi', model: '' }, files), /^pi -p --approve "\$\(cat '\/p'\)"/)
  assert.equal(agentCommand({ runtime: 'custom', command: 'agent --in {prompt_file} --cwd {worktree}' }, files), "agent --in '/p' --cwd '/w/it'\\''s'")
})

test('决策日志：五个字段、不能换行、公式开头加单引号', async () => {
  const { buildRow } = await load('log-decision.mjs')
  assert.equal(buildRow(['阶段', '=决策', '原因', '证据', '结果'], 'T'), "T\t阶段\t'=决策\t原因\t证据\t结果\n")
  assert.throws(() => buildRow(['a', 'b', 'c', 'd']), /用法/)
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
