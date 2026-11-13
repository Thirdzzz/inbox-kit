// 检查需求记录的状态是否合规，阻止会让链路静默停住或无限重试的写法：
// - 中断后被手工改回「待办」却没记「自动重试 k/N」（负责人看不到发生过什么）；
// - 重试额度没用完就标「失败」（会停下来等负责人回复）；
// - 「需要补充」的追问没带四类阻碍标签之一（设计疑问应由 Agent 保守决定）；
// - 状态不在固定集合里；重试计数超过上限；
// - INBOX.md 标题与记录对不上（漏写编号前缀、状态不一致），否则下次运行会把它当新需求重复分诊。
// 用法：node .inbox/scripts/check-status.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { blockerTags, checkoutRoot, inboxMarker, isMain, paths, readConfig, statuses } from './config.mjs'
import { autoRetriesOf } from './interrupt.mjs'

export function parseRecord(file, content) {
  const status = /^status:\s*(\S+)/m.exec(content)?.[1]
  const section = /## 进展记录\n([\s\S]*?)(?=\n## |$)/.exec(content)?.[1] ?? ''
  const progress = section.split('\n').filter((line) => line.startsWith('- '))
  const question = /## 追问\n([\s\S]*?)(?=\n## |$)/.exec(content)?.[1] ?? ''
  return { file, status, progress, question, autoRetries: autoRetriesOf(content) }
}

export function findStatusProblems(records, { maxAutoRetries = 3, enforceFrom = 1 } = {}) {
  const problems = []
  for (const { file, status, progress, question, autoRetries } of records) {
    const last = progress.at(-1) ?? ''
    if (!statuses.includes(status)) {
      problems.push(`${file}：状态「${status}」不在 ${statuses.join('、')} 之内，调度者不会派发也不会汇报它。请改成其中之一。`)
    }
    if (status === '待办' && /中断/.test(last) && !/自动重试 \d+\/\d+/.test(last)) {
      problems.push(`${file}：中断被手工改回了「待办」（最后一条进展「${last.replace(/^- /, '')}」）。请运行 node .inbox/scripts/interrupt.mjs <NNN> "<原因>"，它会记下「自动重试 k/${maxAutoRetries}」。`)
    }
    if (status === '失败' && autoRetries < maxAutoRetries && !/不再自动重试/.test(last)) {
      problems.push(`${file}：标了「失败」但自动重试只用了 ${autoRetries}/${maxAutoRetries}，会停下来等负责人。请改走 node .inbox/scripts/interrupt.mjs <NNN> "<原因>"；确认重试无济于事时加 --no-retry。`)
    }
    if (status === '需要补充' && Number(file.slice(0, 3)) >= enforceFrom && !blockerTags.some((tag) => question.includes(`[${tag}]`))) {
      problems.push(`${file}：「需要补充」的追问必须带 ${blockerTags.map((tag) => `[${tag}]`).join('、')} 之一；其他疑问请选保守做法，写成「假设：…」后继续。`)
    }
    if (autoRetries > maxAutoRetries) {
      problems.push(`${file}：auto_retries=${autoRetries}，超过上限 ${maxAutoRetries}。用尽后应由 interrupt.mjs 标「失败」，不要手工改计数。`)
    }
  }
  return problems
}

// INBOX.md 里每条记录都要有 `## [NNN · 状态]` 标题，且状态与记录一致。
export function findHeadingProblems(inboxText, records) {
  const problems = []
  const area = inboxText.includes(inboxMarker) ? inboxText.slice(inboxText.indexOf(inboxMarker)) : inboxText
  const headings = new Map()
  for (const match of area.matchAll(/^## \[(\d{3}) · ([^\]]+)\]/gm)) headings.set(match[1], match[2].trim())
  for (const { file, status } of records) {
    const id = file.slice(0, 3)
    if (!headings.has(id)) problems.push(`${paths.inbox}：找不到「## [${id} · ${status}]」标题（记录 ${file}）。分诊后必须给标题加上编号和状态，否则下次运行会把它当作新需求重复分诊。`)
    else if (headings.get(id) !== status) problems.push(`${paths.inbox}：${id} 的标题写「${headings.get(id)}」，记录 ${file} 是「${status}」。两处必须一起改。`)
  }
  return problems
}

export function readAllRecords(root) {
  const dir = path.join(root, paths.records)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => /^\d{3}-.*\.md$/.test(name))
    .map((name) => parseRecord(name, readFileSync(path.join(dir, name), 'utf8')))
}

if (isMain(import.meta.url)) {
  const root = checkoutRoot()
  const config = readConfig(root)
  const records = readAllRecords(root)
  const inboxFile = path.join(root, paths.inbox)
  const problems = [...findStatusProblems(records, config), ...(existsSync(inboxFile) ? findHeadingProblems(readFileSync(inboxFile, 'utf8'), records) : [])]
  if (problems.length) {
    console.error(problems.join('\n'))
    process.exitCode = 1
  } else console.log('check-status：需求记录状态合规。')
}
