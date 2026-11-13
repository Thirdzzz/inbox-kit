// 端到端：在临时仓库里安装，再用一个假的开发子代理走完认领 → 启动 → 等待 → 结果 → 集成 → 清理。
// 假子代理是一段 shell 脚本（dev.runtime = custom），按真实子代理的约定写结果文件、提交并推送。
import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { KIT, baseConfig, git, makeRepo, node, recordText, write } from './helpers.mjs'

const json = (result) => {
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

function setStatus(root, id, from, to) {
  const file = path.join(root, `inbox/${id}-示例.md`)
  writeFileSync(file, readFileSync(file, 'utf8').replace(`status: ${from}`, `status: ${to}`))
  const inbox = path.join(root, 'INBOX.md')
  writeFileSync(inbox, readFileSync(inbox, 'utf8').replace(`[${id} · ${from}]`, `[${id} · ${to}]`))
  git(root, 'add', 'INBOX.md', 'inbox')
  git(root, 'commit', '-qm', `docs: ${id} ${to}`)
  git(root, 'push', '-q', 'origin', 'main')
}

const fakeAgent = (body) => ({ ...baseConfig, dev: { runtime: 'custom', command: `sh -c '${body.replaceAll("'", `'\\''`)}' {prompt_file}` } })

function addRecord(root, id, status = '待办') {
  write(root, `inbox/${id}-示例.md`, recordText({ id, status }))
  const inbox = readFileSync(path.join(root, 'INBOX.md'), 'utf8')
  writeFileSync(path.join(root, 'INBOX.md'), `${inbox}\n## [${id} · ${status}] 示例\n详情：[inbox/${id}-示例.md](inbox/${id}-示例.md)\n`)
  git(root, 'add', 'INBOX.md', 'inbox')
  git(root, 'commit', '-qm', `docs: 分诊需求 ${id}`)
  git(root, 'pull', '-q', '--rebase', 'origin', 'main')
  git(root, 'push', '-q', 'origin', 'main')
}

test('安装：生成四个技能和脚本，生成结果与配置一致，钩子已启用', () => {
  const repo = makeRepo()
  try {
    for (const skill of ['inbox', 'inbox-intake', 'inbox-idea', 'inbox-discover']) {
      const text = readFileSync(path.join(repo.root, '.agents/skills', skill, 'SKILL.md'), 'utf8')
      assert.match(text, new RegExp(`^---\\nname: ${skill}\\n`))
      assert.doesNotMatch(text, /\{\{/)
      assert.match(readFileSync(path.join(repo.root, '.agents/skills', skill, 'agents/openai.yaml'), 'utf8'), /allow_implicit_invocation: false/)
    }
    assert.match(readFileSync(path.join(repo.root, '.agents/skills/inbox/SKILL.md'), 'utf8'), /`test -f README\.md`/)
    assert.equal(git(repo.root, 'config', 'core.hooksPath'), '.inbox/hooks')
    assert.equal(repo.run('render.mjs', '--repo', repo.root, '--check').status, 0)
    assert.match(readFileSync(path.join(repo.root, '.gitignore'), 'utf8'), /\.inbox\/decisions\.tsv/)
    // 状态文件只创建不覆盖
    writeFileSync(path.join(repo.root, 'INBOX.md'), '负责人写的内容\n')
    assert.equal(repo.run('render.mjs', '--repo', repo.root).status, 0)
    assert.equal(readFileSync(path.join(repo.root, 'INBOX.md'), 'utf8'), '负责人写的内容\n')
    git(repo.root, 'checkout', '--', 'INBOX.md')
  } finally {
    repo.cleanup()
  }
})

test('配置改了没重新生成：render --check 失败并说明怎么修', () => {
  const repo = makeRepo()
  try {
    const config = { ...baseConfig, commands: { check: 'npm test', fullCheck: 'npm test' } }
    writeFileSync(path.join(repo.root, 'inbox.config.json'), JSON.stringify(config))
    const result = repo.run('render.mjs', '--repo', repo.root, '--check')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /生成文件与配置不一致：\.agents\/skills\/inbox\/SKILL\.md/)
    assert.match(result.stderr, /render\.mjs --repo \./)
  } finally {
    repo.cleanup()
  }
})

test('主分支守卫：状态文件可以直接提交，代码不行，错误里给出正确做法', () => {
  const repo = makeRepo()
  try {
    write(repo.root, 'INBOX.md', '改状态\n')
    git(repo.root, 'add', 'INBOX.md')
    git(repo.root, 'commit', '-qm', 'docs: 状态')
    write(repo.root, 'src/app.js', 'x\n')
    git(repo.root, 'add', 'src/app.js')
    const blocked = spawnSync('git', ['-C', repo.root, 'commit', '-m', 'feat: 直接改代码'], { encoding: 'utf8' })
    assert.notEqual(blocked.status, 0)
    assert.match(blocked.stderr, /不能直接在 main 上提交这些文件：src\/app\.js/)
    assert.match(blocked.stderr, /integrate\.mjs/)
    const allowed = spawnSync('git', ['-C', repo.root, 'commit', '-qm', 'hotfix'], { encoding: 'utf8', env: { ...process.env, INBOX_ALLOW_MAIN_COMMIT: '1' } })
    assert.equal(allowed.status, 0, allowed.stderr)
  } finally {
    repo.cleanup()
  }
})

test('完整流程：认领、启动假子代理、等待结束、读结果、检查越权、集成、清理', () => {
  const agent = [
    'set -e',
    'mkdir -p inbox/results',
    'echo "功能" > feature.txt',
    'printf "返回：ready\\n## 进展记录\\n- 子代理 · 完成\\n## 结果\\n- 改了什么：feature.txt\\n- 假设：用纯文本\\n" > inbox/results/$INBOX_REQUIREMENT.md',
    'git add feature.txt inbox/results',
    'git commit -qm "feat: 示例功能"',
    'git push -q -u origin inbox/$INBOX_REQUIREMENT',
    'echo 完成',
  ].join('\n')
  const repo = makeRepo({ config: fakeAgent(agent) })
  try {
    addRecord(repo.root, '001')
    const claimed = json(repo.run('worktree.mjs', 'claim', '001'))
    assert.equal(claimed.branch, 'inbox/001')
    assert.ok(existsSync(claimed.path))
    // 第二次认领：已存在就接管，不会新建
    assert.equal(json(repo.run('worktree.mjs', 'claim', '001')).adopted, true)
    // 记录还是「待办」：工作树是停放状态，启动会被拒绝
    assert.equal(json(repo.run('watchdog.mjs'))[0].state, 'parked')
    const refused = repo.run('launch.mjs', 'start', '001')
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /先把记录和 INBOX\.md 标题改成「进行中」/)
    setStatus(repo.root, '001', '待办', '进行中')
    assert.equal(json(repo.run('watchdog.mjs'))[0].state, 'launching')

    const started = json(repo.run('launch.mjs', 'start', '001', '--note', '第一次'))
    assert.ok(started.pid > 0)
    const brief = readFileSync(git(claimed.path, 'rev-parse', '--path-format=absolute', '--git-path', 'inbox-agent-prompt.md'), 'utf8')
    assert.match(brief, /你是需求 001 的开发子代理/)
    assert.match(brief, /## 这一次的附加说明\n第一次/)

    const waited = json(repo.run('launch.mjs', 'wait', '--minutes', '1'))
    assert.equal(waited.timedOut, false)
    assert.deepEqual(waited.needsAction.map((s) => [s.id, s.state]), [['001', 'exited']])

    const result = json(repo.run('launch.mjs', 'result', '001'))
    assert.equal(result.exitCode, 0)
    assert.equal(result.returned, 'ready')
    assert.equal(result.resultsFile, path.join(repo.base, 'repo.inbox-worktrees/001/inbox/results/001.md'))

    assert.equal(repo.run('check.mjs', '001').status, 0)
    const integrated = repo.run('integrate.mjs', '001')
    assert.equal(integrated.status, 0, integrated.stderr)
    assert.match(integrated.stdout, /已集成到 main/)
    assert.ok(git(repo.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n').includes('feature.txt'))

    const cleaned = repo.run('worktree.mjs', 'cleanup', '001')
    assert.match(cleaned.stdout, /已删除工作树/)
    assert.ok(!existsSync(claimed.path))
    assert.equal(git(repo.remote, 'branch', '--list', 'inbox/001'), '')
  } finally {
    repo.cleanup()
  }
})

test('越权：需求分支改了调度者的记录，check.mjs 失败并指出该写哪个文件', () => {
  const repo = makeRepo()
  try {
    addRecord(repo.root, '002')
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '002'))
    write(wt, 'inbox/002-示例.md', '子代理乱改\n')
    write(wt, 'INBOX.md', '子代理乱改\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'wip')
    const result = repo.run('check.mjs', '002')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /改动了它不该改的文件/)
    assert.match(result.stderr, /inbox\/results\/002\.md/)
  } finally {
    repo.cleanup()
  }
})

test('集成：检查命令失败时不推送，并原样显示检查输出', () => {
  const repo = makeRepo({ config: { ...baseConfig, commands: { check: 'true', fullCheck: 'echo 测试失败了 && exit 3' } } })
  try {
    addRecord(repo.root, '003')
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '003'))
    write(wt, 'x.txt', 'x\n')
    git(wt, 'add', 'x.txt')
    git(wt, 'commit', '-qm', 'feat: x')
    const before = git(repo.remote, 'rev-parse', 'main')
    const result = repo.run('integrate.mjs', '003')
    assert.equal(result.status, 1)
    assert.match(result.stdout, /测试失败了/)
    assert.match(result.stderr, /检查命令退出码 3/)
    assert.equal(git(repo.remote, 'rev-parse', 'main'), before)
  } finally {
    repo.cleanup()
  }
})

test('集成：主分支在检查期间前进，会重新变基、重新检查后再推送', () => {
  const repo = makeRepo()
  try {
    addRecord(repo.root, '004')
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '004'))
    write(wt, 'y.txt', 'y\n')
    git(wt, 'add', 'y.txt')
    git(wt, 'commit', '-qm', 'feat: y')
    // 第一次检查时另一个会话推进主分支，之后的检查不再干扰。
    const other = path.join(repo.base, 'other')
    execFileSync('git', ['clone', '-q', repo.remote, other])
    const marker = path.join(repo.base, 'ran')
    const script = path.join(repo.base, 'check.sh')
    writeFileSync(script, `if [ ! -f ${marker} ]; then touch ${marker}; cd ${other} && echo z > z.txt && git add z.txt && git -c user.name=t -c user.email=t@t commit -qm z && git push -q origin HEAD:main; fi\necho "检查 $(git rev-parse HEAD)"\n`)
    const result = repo.run('integrate.mjs', '004', '--check', `sh ${script}`)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /第 2 次尝试/)
    const files = git(repo.remote, 'ls-tree', '-r', '--name-only', 'main').split('\n')
    assert.ok(files.includes('y.txt') && files.includes('z.txt'))
  } finally {
    repo.cleanup()
  }
})

test('看门狗：子代理卡住没有动静时报 stale，停掉后报 died，再走中断重试', () => {
  const repo = makeRepo({ config: { ...fakeAgent('sleep 600'), idleLimitMinutes: 15 } })
  try {
    addRecord(repo.root, '005', '进行中')
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '005'))
    json(repo.run('launch.mjs', 'start', '005'))
    assert.equal(json(repo.run('watchdog.mjs'))[0].state, 'live')
    // 把所有动静拨回 20 分钟前，模拟卡死。
    const old = new Date(Date.now() - 20 * 60000)
    const gitPath = (name) => git(wt, 'rev-parse', '--path-format=absolute', '--git-path', name)
    for (const file of [path.join(wt, '.git'), path.join(wt, 'README.md'), path.join(wt, 'INBOX.md'), path.join(wt, 'inbox.config.json'), gitPath('index'), gitPath('logs/HEAD'), gitPath('inbox-agent-id'), gitPath('inbox-agent.log')]) {
      if (existsSync(file)) utimesSync(file, old, old)
    }
    execFileSync('sh', ['-c', `find ${wt} -path ${wt}/.git -prune -o -exec touch -t ${old.toISOString().replace(/[-:T]/g, '').slice(0, 12)} {} +`])
    const watched = repo.run('watchdog.mjs')
    assert.equal(JSON.parse(watched.stdout)[0].state, 'stale')
    assert.match(watched.stderr, /launch\.mjs stop 005/)
    assert.match(repo.run('launch.mjs', 'stop', '005').stdout, /已停止/)
    // 进程组收到 SIGTERM 后外层 sh 也退出，没有写下退出码。
    for (let i = 0; i < 20 && JSON.parse(repo.run('watchdog.mjs').stdout)[0].state === 'stale'; i++) execFileSync('sleep', ['0.2'])
    assert.equal(JSON.parse(repo.run('watchdog.mjs').stdout)[0].state, 'died')
    const interrupted = repo.run('interrupt.mjs', '005', '子代理卡死')
    assert.equal(interrupted.status, 0, interrupted.stderr)
    assert.match(readFileSync(path.join(repo.root, 'inbox/005-示例.md'), 'utf8'), /^auto_retries: 1$/m)
    assert.match(readFileSync(path.join(repo.root, 'INBOX.md'), 'utf8'), /## \[005 · 待办\] 示例\n详情：.*\n说明：子代理中断（子代理卡死），已自动重试 1\/3/)
    assert.equal(repo.run('check-status.mjs').status, 0)
  } finally {
    repo.cleanup()
  }
})

test('状态同步：只提交想法簿和发现账本，不带走负责人的其他改动', () => {
  const repo = makeRepo()
  try {
    write(repo.root, 'IDEAS.md', '# 想法簿\n- 一个想法\n')
    write(repo.root, 'README.md', '# 负责人正在改\n')
    const result = repo.run('state-sync.mjs')
    assert.match(result.stdout, /已提交 IDEAS\.md/)
    assert.match(result.stdout, /已推送/)
    assert.deepEqual(git(repo.remote, 'show', '--name-only', '--format=', 'main').split('\n'), ['IDEAS.md'])
    assert.match(git(repo.root, 'status', '--porcelain'), /README\.md/)
  } finally {
    repo.cleanup()
  }
})

test('体检：缺远端时失败并给出修法；探测能认出 npm 项目的检查命令', async () => {
  const repo = makeRepo({ render: false })
  try {
    git(repo.root, 'remote', 'set-url', 'origin', '../remote.git')
    const relative = node(repo.root, path.join(KIT, 'scripts/doctor.mjs'), '--repo', repo.root, '--skip-commands')
    assert.match(relative.stdout, /✗ 远端：origin 是相对路径 \.\.\/remote\.git[^\n]*\n\s+→ git remote set-url origin \//)
    git(repo.root, 'remote', 'remove', 'origin')
    const doctor = node(repo.root, path.join(KIT, 'scripts/doctor.mjs'), '--repo', repo.root, '--skip-commands')
    assert.equal(doctor.status, 1)
    assert.match(doctor.stdout, /✗ 远端：没有远端 origin\n\s+→ git remote add/)
    write(repo.root, 'app/package.json', JSON.stringify({ scripts: { lint: 'x', test: 'y', 'test:e2e': 'z' } }))
    write(repo.root, 'app/package-lock.json', '{}')
    const { detect } = await import(path.join(KIT, 'scripts/detect.mjs'))
    const found = detect(repo.root)
    assert.equal(found.suggested.commands.check, 'cd app && npm run lint && npm test')
    assert.equal(found.suggested.commands.fullCheck, 'cd app && npm run lint && npm test && npm run test:e2e')
    assert.equal(found.suggested.commands.install, 'cd app && npm ci')
  } finally {
    repo.cleanup()
  }
})

test('门禁不能被分支改掉：分支把 fullCheck 改成 true，集成仍用主检出的检查并拒绝越权', () => {
  const repo = makeRepo({ config: { ...baseConfig, commands: { check: 'true', fullCheck: 'echo 主检出的检查 && exit 7' } } })
  try {
    addRecord(repo.root, '006')
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '006'))
    write(wt, 'inbox.config.json', JSON.stringify({ ...baseConfig, commands: { check: 'true', fullCheck: 'true' } }))
    write(wt, 'feature.txt', 'x\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'feat: 顺手改了配置')
    const before = git(repo.remote, 'rev-parse', 'main')
    const result = repo.run('integrate.mjs', '006')
    assert.equal(result.status, 1)
    assert.match(result.stdout, /集成检查命令：echo 主检出的检查 && exit 7（取自主检出的 inbox\.config\.json）/)
    assert.match(result.stderr, /集成失败 \[ownership\][\s\S]*inbox\.config\.json/)
    assert.equal(git(repo.remote, 'rev-parse', 'main'), before)
  } finally {
    repo.cleanup()
  }
})

test('重试：--retry 把待办改回进行中并提交推送，再启动子代理', () => {
  const repo = makeRepo({ config: fakeAgent('echo 重试运行') })
  try {
    addRecord(repo.root, '007', '进行中')
    json(repo.run('worktree.mjs', 'claim', '007'))
    assert.equal(repo.run('interrupt.mjs', '007', '超时').status, 0)
    git(repo.root, 'add', 'INBOX.md', 'inbox')
    git(repo.root, 'commit', '-qm', 'docs: 中断')
    const started = json(repo.run('launch.mjs', 'start', '007', '--retry', '--note', '上次超时'))
    assert.ok(started.pid > 0)
    assert.match(readFileSync(path.join(repo.root, 'inbox/007-示例.md'), 'utf8'), /^status: 进行中$/m)
    assert.match(git(repo.remote, 'log', '-1', '--format=%s', 'main'), /重新派发需求 007/)
    const waited = json(repo.run('launch.mjs', 'wait', '--minutes', '1'))
    assert.deepEqual(waited.needsAction.map((s) => s.state), ['exited'])
  } finally {
    repo.cleanup()
  }
})

test('看门狗：进行中的记录没有工作树报 orphan；残缺工作树报 broken 而不是崩溃', () => {
  const repo = makeRepo()
  try {
    addRecord(repo.root, '008', '进行中')
    assert.deepEqual(JSON.parse(repo.run('watchdog.mjs').stdout).map((s) => [s.id, s.state]), [['008', 'orphan']])
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '008'))
    execFileSync('rm', ['-f', path.join(wt, '.git')])
    const watched = repo.run('watchdog.mjs')
    assert.equal(watched.status, 0, watched.stderr)
    assert.equal(JSON.parse(watched.stdout)[0].state, 'broken')
    // 残缺目录：认领给出明确修法，清理后可以重新认领。
    const claim = repo.run('worktree.mjs', 'claim', '008')
    assert.equal(claim.status, 1)
    assert.match(claim.stderr, /cleanup 008 --keep-branch/)
    assert.equal(repo.run('worktree.mjs', 'cleanup', '008', '--keep-branch').status, 0)
    assert.equal(json(repo.run('worktree.mjs', 'claim', '008')).created, true)
  } finally {
    repo.cleanup()
  }
})

test('认领：被其他会话占用时退出码 3；工作树在仓库外，不会被项目工具扫到', () => {
  const repo = makeRepo()
  try {
    addRecord(repo.root, '009')
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '009'))
    assert.ok(!wt.startsWith(`${repo.root}/`), '默认工作树目录应在仓库外')
    // 同一分支在别处检出：模拟另一个会话用另一个目录认领了它。
    execFileSync('git', ['-C', repo.root, 'worktree', 'move', wt, path.join(repo.base, 'elsewhere')])
    const second = repo.run('worktree.mjs', 'claim', '009')
    assert.equal(second.status, 3, second.stderr)
  } finally {
    repo.cleanup()
  }
})

test('钩子：.git/hooks 里已有钩子（如 git-lfs）时不设置 core.hooksPath', () => {
  const repo = makeRepo({ render: false })
  try {
    write(repo.root, '.git/hooks/pre-push', '#!/bin/sh\ngit lfs pre-push "$@"\n')
    const result = node(repo.root, path.join(KIT, 'scripts/render.mjs'), '--repo', repo.root)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /已有钩子（pre-push）/)
    assert.throws(() => git(repo.root, 'config', '--get', 'core.hooksPath'))
  } finally {
    repo.cleanup()
  }
})

test('升级：kit 里删掉的旧脚本会被清除，--check 能发现残留', () => {
  const repo = makeRepo()
  try {
    write(repo.root, '.inbox/scripts/obsolete.mjs', '// 旧版本留下的脚本\n')
    const check = repo.run('render.mjs', '--repo', repo.root, '--check')
    assert.equal(check.status, 1)
    assert.match(check.stderr, /obsolete\.mjs 是 kit 里没有的文件/)
    assert.equal(node(repo.root, path.join(KIT, 'scripts/render.mjs'), '--repo', repo.root).status, 0)
    assert.ok(!existsSync(path.join(repo.root, '.inbox/scripts/obsolete.mjs')))
    assert.equal(repo.run('render.mjs', '--repo', repo.root, '--check').status, 0)
  } finally {
    repo.cleanup()
  }
})

test('集成：受保护分支等服务端拒绝不重试，直接报出原因', () => {
  const repo = makeRepo()
  try {
    write(repo.remote, 'hooks/pre-receive', '#!/bin/sh\necho "main 受保护" >&2\nexit 1\n')
    execFileSync('chmod', ['+x', path.join(repo.remote, 'hooks/pre-receive')])
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '010'))
    write(wt, 'p.txt', 'p\n')
    git(wt, 'add', 'p.txt')
    git(wt, 'commit', '-qm', 'feat: p')
    const result = repo.run('integrate.mjs', '010')
    assert.equal(result.status, 1)
    assert.match(result.stderr, /集成失败 \[push-failed\][\s\S]*main 受保护/)
    assert.doesNotMatch(result.stdout, /第 2 次/)
  } finally {
    repo.cleanup()
  }
})

test('状态同步 --all：集成推进主分支后，主检出的状态提交变基推送，不再卡在分叉（pi 验收中真实发生过）', () => {
  const repo = makeRepo()
  try {
    addRecord(repo.root, '011', '进行中')
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '011'))
    write(wt, 'f.txt', 'f\n')
    git(wt, 'add', 'f.txt')
    git(wt, 'commit', '-qm', 'feat: f')
    assert.equal(repo.run('integrate.mjs', '011').status, 0)
    // 调度者在主检出改状态并提交：此时本地主分支已落后远端。
    const record = path.join(repo.root, 'inbox/011-示例.md')
    write(repo.root, 'inbox/011-示例.md', readFileSync(record, 'utf8').replace('status: 进行中', 'status: 已上线'))
    write(repo.root, 'README.md', '# 负责人正在改\n')
    git(repo.root, 'commit', '-qm', 'docs: 先提交了一次状态', '--', 'inbox/011-示例.md')
    const synced = repo.run('state-sync.mjs', '--all', '-m', 'docs: 需求 011 已上线')
    assert.equal(synced.status, 0, synced.stdout)
    assert.equal(git(repo.root, 'rev-parse', 'HEAD'), git(repo.remote, 'rev-parse', 'main'))
    assert.match(git(repo.remote, 'log', '--format=%s', '-3', 'main'), /先提交了一次状态\nfeat: f/)
    assert.match(git(repo.root, 'status', '--porcelain'), /README\.md/)
    // 本地主分支混进了非状态文件：拒绝推送。
    write(repo.root, 'code.js', 'x\n')
    git(repo.root, 'add', 'code.js')
    execFileSync('git', ['-C', repo.root, 'commit', '-qm', 'oops', '--no-verify'])
    const refused = repo.run('state-sync.mjs', '--all')
    assert.equal(refused.status, 1)
    assert.match(refused.stdout, /含有状态文件之外的改动（code\.js）/)
  } finally {
    repo.cleanup()
  }
})

test('强制审阅判定：工作树已清理（停在待检查）时改看远端分支', () => {
  const repo = makeRepo({ config: { ...baseConfig, review: { paths: ['src/storage/**'], rules: [] } } })
  try {
    addRecord(repo.root, '012')
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '012'))
    write(wt, 'src/storage/format.js', 'export const V = 2\n')
    git(wt, 'add', '-A')
    git(wt, 'commit', '-qm', 'feat: 升级格式')
    git(wt, 'push', '-q', 'origin', 'HEAD:inbox/012')
    assert.deepEqual(json(repo.run('needs-review.mjs', '012')).files, ['src/storage/format.js'])
    assert.equal(repo.run('worktree.mjs', 'cleanup', '012', '--keep-branch').status, 0)
    const after = repo.run('needs-review.mjs', '012')
    assert.equal(after.status, 0, after.stderr)
    assert.equal(JSON.parse(after.stdout).required, true)
  } finally {
    repo.cleanup()
  }
})

test('部署：command 模式部署后用确认命令判定成功、失败、没有结论', () => {
  const config = { ...baseConfig, deploy: { mode: 'command', postMergeCommand: 'echo deployed > deployed.txt', verify: 'command', verifyCommand: 'sh verify.sh {sha}' } }
  const repo = makeRepo({ config })
  try {
    const verify = (code) => write(repo.root, 'verify.sh', `echo 检查 $1\nexit ${code}\n`)
    verify(0)
    const ok = repo.run('deploy-status.mjs', 'abc123', '--timeout-minutes', '0')
    assert.equal(ok.status, 0, ok.stdout)
    assert.match(ok.stdout, /部署成功：abc123（检查 abc123）/)
    verify(1)
    assert.equal(repo.run('deploy-status.mjs', 'abc123').status, 1)
    verify(5)
    const pending = repo.run('deploy-status.mjs', 'abc123', '--timeout-minutes', '0')
    assert.equal(pending.status, 3)
    assert.match(pending.stdout, /没有结论/)
    // 生成的调度技能写出了部署命令与确认步骤。
    const skill = readFileSync(path.join(repo.root, '.agents/skills/inbox/SKILL.md'), 'utf8')
    assert.match(skill, /echo deployed > deployed\.txt/)
    assert.match(skill, /deploy-status\.mjs <sha>/)
  } finally {
    repo.cleanup()
  }
})

test('回收：按记录状态删掉没用的工作树和分支，未推送的工作与进行中的需求不动', () => {
  const repo = makeRepo()
  try {
    const exists = (ref) => {
      try {
        git(repo.root, 'rev-parse', '--verify', '-q', ref)
        return true
      } catch {
        return false
      }
    }
    const remoteHas = (branch) => git(repo.remote, 'branch', '--list', branch) !== ''
    const commitIn = (wt, file, push = true) => {
      write(wt, file, `${file}\n`)
      git(wt, 'add', file)
      git(wt, 'commit', '-qm', `feat: ${file}`)
      if (push) git(wt, 'push', '-q', 'origin', 'HEAD')
    }
    const claim = (id) => json(repo.run('worktree.mjs', 'claim', id)).path
    // 020 已上线：集成后忘了清理。
    addRecord(repo.root, '020', '已上线')
    const w20 = claim('020')
    commitIn(w20, 'a.txt')
    assert.equal(repo.run('integrate.mjs', '020').status, 0)
    // 021 待检查：已推送，工作树干净。
    addRecord(repo.root, '021', '待检查')
    commitIn(claim('021'), 'b.txt')
    // 022 待办：有未推送的提交。
    addRecord(repo.root, '022', '待办')
    commitIn(claim('022'), 'c.txt', false)
    // 023 进行中：子代理在干活。
    addRecord(repo.root, '023', '进行中')
    const w23 = claim('023')
    // 024 已否决：分支上有没合入的代码。
    addRecord(repo.root, '024', '已否决')
    commitIn(claim('024'), 'd.txt')
    // 025 没有记录、有没合入的提交；026 没有记录、什么都没做。
    commitIn(claim('025'), 'e.txt')
    claim('026')
    // 已落地的回滚分支。
    git(repo.root, 'fetch', '-q', 'origin')
    const rb = path.join(repo.base, 'repo.inbox-worktrees/rollback-020')
    git(repo.root, 'worktree', 'add', '-q', '-b', 'rollback/020', rb, 'origin/main')
    git(repo.root, 'commit', '-qm', 'docs: 记录', '--allow-empty')
    git(repo.root, 'push', '-q')

    // 刚认领的工作树在启动窗口内不回收（调度者可能正要把它改成「进行中」）；终态的照删。
    assert.deepEqual(JSON.parse(repo.run('gc.mjs', '--check').stdout).removed.map((r) => r.id), ['020', '024'])
    const old = new Date(Date.now() - 10 * 60000)
    for (const name of readdirSync(path.join(repo.base, 'repo.inbox-worktrees'))) utimesSync(path.join(repo.base, 'repo.inbox-worktrees', name, '.git'), old, old)
    const check = repo.run('gc.mjs', '--check')
    assert.equal(check.status, 1)
    assert.match(check.stderr, /020（已上线）的工作树、本地分支、远端分支已经没用/)

    const result = repo.run('gc.mjs')
    assert.equal(result.status, 0, result.stderr)
    const { kept } = JSON.parse(result.stdout)
    for (const id of ['020', '024', '026']) {
      assert.ok(!existsSync(path.join(repo.base, `repo.inbox-worktrees/${id}`)), `${id} 工作树应删除`)
      assert.ok(!exists(`refs/heads/inbox/${id}`), `${id} 本地分支应删除`)
      assert.ok(!remoteHas(`inbox/${id}`), `${id} 远端分支应删除`)
    }
    assert.ok(!existsSync(path.join(repo.base, 'repo.inbox-worktrees/021')))
    assert.ok(!exists('refs/heads/inbox/021'))
    assert.ok(remoteHas('inbox/021'), '待检查的远端分支要留给负责人审阅')
    assert.ok(existsSync(path.join(repo.base, 'repo.inbox-worktrees/022')), '未推送的提交不能丢')
    assert.ok(existsSync(w23), '进行中的工作树不能动')
    assert.ok(existsSync(path.join(repo.base, 'repo.inbox-worktrees/025')), '没有记录但有未合入的提交，要留给人确认')
    assert.ok(!existsSync(rb) && !exists('refs/heads/rollback/020'), '已落地的回滚工作树和分支应删除')
    assert.deepEqual(kept.map((k) => k.id), ['022', '025'])

    // 子代理跑完得很快：认领不到 5 分钟，但已经启动过子代理，收尾时照样回收。
    addRecord(repo.root, '027', '待检查')
    const w27 = claim('027')
    commitIn(w27, 'f.txt')
    const gitDir = git(w27, 'rev-parse', '--path-format=absolute', '--git-dir')
    write(gitDir, 'inbox-agent-id', 'pid:999999@Mon Jan  1 00:00:00 2001\n')
    assert.equal(repo.run('gc.mjs').status, 0)
    assert.ok(!existsSync(w27), '子代理结束后的待检查工作树应回收，不受启动窗口保护')

    // 回收后再检查：只剩需要人看的 025。
    const again = repo.run('gc.mjs', '--check')
    assert.equal(again.status, 1)
    assert.doesNotMatch(again.stderr, /已经没用/)
    assert.match(again.stderr, /025：没有需求记录/)
    // 待审阅需求被「通过」后仍能从远端接管合并。
    assert.equal(json(repo.run('worktree.mjs', 'claim', '021')).adopted, true)
  } finally {
    repo.cleanup()
  }
})

test('状态同步 --all 推送成功后自动回收：已上线需求的工作树和分支不残留', () => {
  const repo = makeRepo()
  try {
    addRecord(repo.root, '030', '进行中')
    const { path: wt } = json(repo.run('worktree.mjs', 'claim', '030'))
    write(wt, 'x.txt', 'x\n')
    git(wt, 'add', 'x.txt')
    git(wt, 'commit', '-qm', 'feat: x')
    git(wt, 'push', '-q', 'origin', 'HEAD:inbox/030')
    assert.equal(repo.run('integrate.mjs', '030').status, 0)
    const record = path.join(repo.root, 'inbox/030-示例.md')
    writeFileSync(record, readFileSync(record, 'utf8').replace('status: 进行中', 'status: 已上线'))
    writeFileSync(path.join(repo.root, 'INBOX.md'), readFileSync(path.join(repo.root, 'INBOX.md'), 'utf8').replace('[030 · 进行中]', '[030 · 已上线]'))
    const synced = repo.run('state-sync.mjs', '--all', '-m', 'docs: 需求 030 已上线')
    assert.equal(synced.status, 0, synced.stdout)
    assert.match(synced.stdout, /回收：030（已上线）删除了工作树、本地分支、远端分支/)
    assert.ok(!existsSync(wt))
    assert.equal(git(repo.remote, 'branch', '--list', 'inbox/*'), '')
    assert.equal(git(repo.root, 'branch', '--list', 'inbox/*'), '')
    assert.ok(!existsSync(path.join(repo.base, 'repo.inbox-worktrees')), '空的工作树目录也删掉')
    assert.equal(repo.run('gc.mjs', '--check').status, 0)
  } finally {
    repo.cleanup()
  }
})
