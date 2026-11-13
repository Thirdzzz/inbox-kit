// 需求发现的信号收集：只读，向标准输出打印 Markdown。每行都带「文件:行号」或日期，候选需求可以直接引用。
// 用法：node .inbox/scripts/signals.mjs [--root <主检出路径>]
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { argValue, inboxMarker, mainRoot, paths, readConfig } from './config.mjs'

const root = path.resolve(argValue(process.argv.slice(2), '--root') ?? mainRoot())
const config = readConfig(root)
const rel = (p) => path.relative(root, p)
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
const lines = (p) => read(p).split('\n')
const clip = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}…` : s)
const out = []
const section = (title, rows, note) => {
  out.push(`\n## ${title}`)
  if (note) out.push(`_${note}_`)
  out.push(rows.length ? rows.join('\n') : '- （无）')
}
const recordFiles = () => {
  const dir = path.join(root, paths.records)
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{3}-.*\.md$/.test(f)).sort().map((f) => path.join(dir, f)) : []
}

// 1. 结果文件与记录里自述的未验证项。
{
  const rows = []
  const resultsDir = path.join(root, paths.results)
  const files = [...(fs.existsSync(resultsDir) ? fs.readdirSync(resultsDir).filter((f) => f.endsWith('.md')).map((f) => path.join(resultsDir, f)) : []), ...recordFiles()]
  for (const p of files) {
    lines(p).forEach((l, i) => {
      const m = l.match(/(没有验证的|未验证|待验证)[：:](.*)$/)
      const body = m?.[2].trim()
      if (body && !/^(无|没有)[。.]?$/.test(body)) rows.push(`- ${rel(p)}:${i + 1} ${clip(body)}`)
    })
  }
  section('开放的尾巴（自述未验证的内容）', rows, '先确认它现在是否仍成立，再决定值不值得做。')
}

// 2. 负责人在收件箱里的原话与已有需求，兼作去重底表。
{
  const p = path.join(root, paths.inbox)
  const all = lines(p)
  const start = all.findIndex((l) => l.includes(inboxMarker))
  const rows = []
  all.forEach((l, i) => {
    if (i > start && (/^##\s/.test(l) || /^> 回复/.test(l))) rows.push(`- ${rel(p)}:${i + 1} ${clip(l.replace(/^##\s*/, ''), 110)}`)
  })
  section('负责人原话与已有需求（去重底表）', rows, '带 [NNN · 状态] 的是已有需求；同一文件或同一行为的候选标「与 NNN 重叠」，不要再提。')
}

// 3. 产品方向：配置里列出的文档的标题行，以及路线图。
{
  const rows = []
  const docs = [...new Set([config.product.roadmap, ...config.product.docs].filter(Boolean))]
  for (const doc of docs) {
    const p = path.join(root, doc)
    if (!fs.existsSync(p)) {
      rows.push(`- ${doc}（配置里列出，但文件不存在）`)
      continue
    }
    lines(p).forEach((l, i) => {
      if (/^#{1,3}\s/.test(l) || /^\d+\.\s/.test(l) || /不做|取舍|目标|优先/.test(l)) rows.push(`- ${doc}:${i + 1} ${clip(l, 180)}`)
    })
  }
  section('方向与边界（产品文档、路线图）', rows, '候选必须符合当前阶段，且不触碰「不做」。')
}

// 4. 发现账本：偏好、反偏好、已否决、暂缓。
{
  const p = path.join(root, paths.ledger)
  const rows = lines(p).flatMap((l, i) => (/^##\s|^- /.test(l) ? [`- ${paths.ledger}:${i + 1} ${clip(l, 180)}`] : []))
  section('发现账本（偏好、已否决、暂缓）', rows, '已否决的不再提；暂缓的等重提条件满足。')
}

// 5. 代码侧标记：技术债单列，不混进功能候选。
{
  const rows = []
  try {
    const dirs = config.product.codeDirs.length ? config.product.codeDirs : ['.']
    const grep = execFileSync('git', ['grep', '-nE', 'TODO|FIXME|HACK|XXX|\\.skip\\(|\\.only\\(', '--', ...dirs], { cwd: root, encoding: 'utf8' })
    for (const l of grep.split('\n').filter(Boolean).filter((l) => !l.startsWith('.inbox/') && !l.startsWith(`${paths.records}/`)).slice(0, 25)) rows.push(`- ${clip(l, 170)}`)
  } catch {}
  section('代码侧标记（技术债，单列）', rows)
}

// 6. 最近提交的走向。
{
  let rows = []
  try {
    rows = execFileSync('git', ['log', '--oneline', '-n', '15'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => `- ${clip(l, 120)}`)
  } catch {}
  section('最近 15 个提交（走向）', rows)
}

// 7. 负责人对 Agent 说过的话：pi 与 Codex 的会话记录里，含抱怨或纠正措辞的用户消息。
{
  const hit = /不合理|不满意|不对|不方便|不要|不想|应该|希望|为什么|还是|麻烦|太(丑|大|小|多|少|慢|乱)|怎么(没|不|还)|看不|找不|点不|wrong|annoying|should|why/i
  const belongs = (cwd) => cwd && (cwd === root || cwd.startsWith(`${root}/`))
  const msgs = []
  const textOf = (content) => (Array.isArray(content) ? content.map((x) => x.text ?? '').join('') : String(content ?? '')).trim()
  const keep = (ts, t) => {
    if (t.length > 8 && !/^[<#]/.test(t) && hit.test(t)) msgs.push([ts ?? '', t.replace(/\s+/g, ' ')])
  }
  // pi：目录名由工作目录推出；需求工作树也在主检出之下，前缀相同。
  const piBase = path.join(os.homedir(), '.pi/agent/sessions')
  const key = `-${root.replaceAll('/', '-').replace(/^-/, '')}`
  for (const dir of fs.existsSync(piBase) ? fs.readdirSync(piBase).filter((d) => d.startsWith(`-${key}`)) : []) {
    for (const f of fs.readdirSync(path.join(piBase, dir)).filter((x) => x.endsWith('.jsonl'))) {
      for (const l of read(path.join(piBase, dir, f)).split('\n')) {
        try {
          const o = JSON.parse(l)
          if (o.message?.role === 'user') keep(o.timestamp, textOf(o.message.content))
        } catch {}
      }
    }
  }
  // Codex：按日期分目录，会话首行 session_meta 记着工作目录。只看最近 60 天。
  const codexBase = path.join(os.homedir(), '.codex/sessions')
  const since = Date.now() - 60 * 86400000
  const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.jsonl') ? [path.join(dir, e.name)] : [])) : [])
  for (const f of walk(codexBase).filter((f) => fs.statSync(f).mtimeMs > since)) {
    const all = read(f).split('\n')
    try {
      if (!belongs(JSON.parse(all[0]).payload?.cwd)) continue
    } catch {
      continue
    }
    for (const l of all) {
      try {
        const o = JSON.parse(l)
        if (o.type === 'response_item' && o.payload?.role === 'user') keep(o.timestamp, textOf(o.payload.content))
      } catch {}
    }
  }
  msgs.sort((x, y) => x[0].localeCompare(y[0]))
  section('负责人对 Agent 说过的话（最近 40 条含抱怨或纠正措辞的）', msgs.slice(-40).map(([ts, t]) => `- ${ts.slice(0, 10)} ${clip(t, 170)}`), '会话原文里流程话题很多，只取关于产品体验的；同一抱怨出现两次以上是强信号。')
}

// 8. 返工痕迹：首次实现没对上负责人意图的地方。
{
  const rows = []
  for (const p of recordFiles()) {
    lines(p).forEach((l, i) => {
      if (/返工|打回|仍不满意|不符合|重新做/.test(l)) rows.push(`- ${rel(p)}:${i + 1} ${clip(l.replace(/^[-\s]*/, ''), 150)}`)
    })
  }
  section('返工痕迹', rows, '同一区域反复返工，说明负责人的真实标准没写进验收标准。')
}

out.push('\n## 脚本之外必须自己读')
out.push([`- ${paths.ideas}（想法簿${fs.existsSync(path.join(root, paths.ideas)) ? '' : '，尚不存在：负责人还没用 inbox-idea 记过想法'}）`, `- ${[config.product.glossary, ...config.product.docs].filter(Boolean).join('、') || '（配置里没有列出产品文档）'}`, '- 真实应用：按发现技能的走查步骤实际用一遍主要场景'].join('\n'))
process.stdout.write(`# 信号收集（${new Date().toISOString().slice(0, 10)}，${config.projectName || path.basename(root)}）\n${out.join('\n')}\n`)
