// 处理中断或失败的「进行中」需求：先在重试额度内自动改回「待办」，下一轮直接重派；额度用尽才改「失败」交给负责人。
// 为什么：中断后静默改回「待办」，负责人看不到发生过什么；一律停在「失败」又会让整条链路等人回复。
// 用法：node .inbox/scripts/interrupt.mjs <NNN> "<原因>" [--no-retry]（改主检出里的文件，不提交；调度者按批提交）
// --no-retry 只用于重试也无济于事的情形（如部署失败已回滚）。只改 INBOX.md 与对应的 inbox/NNN-*.md。
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isMain, mainRoot, paths, readConfig } from './config.mjs'

export function autoRetriesOf(record) {
  return Number(/^auto_retries:\s*(\d+)\s*$/m.exec(record)?.[1] ?? 0)
}

export function interruptText({ inbox, record, id, reason, date, retry = true, maxAutoRetries = 3 }) {
  if (!reason?.trim()) throw new Error('必须写明中断原因')
  // 原因要嵌进句子里，去掉末尾标点，避免出现「。。」。
  reason = reason.trim().replace(/[。.，,；;！!]+$/u, '')
  if (!/^\d{3}$/.test(id)) throw new Error(`编号无效：${id}`)

  const inboxLines = inbox.split('\n')
  const headings = inboxLines.flatMap((line, index) => (line.startsWith(`## [${id} · 进行中]`) ? [index] : []))
  if (headings.length !== 1) throw new Error(`INBOX.md 中应恰好有一个「${id} · 进行中」标题，实际 ${headings.length} 个`)

  const used = autoRetriesOf(record)
  const autoRetry = retry && used < maxAutoRetries
  const attempt = used + 1
  const nextStatus = autoRetry ? '待办' : '失败'

  // 标题下保留「详情：」，把「说明：」换成中断说明；没有就插在详情之后。负责人写的正文和回复保持原样。
  const at = headings[0]
  inboxLines[at] = inboxLines[at].replace('· 进行中]', `· ${nextStatus}]`)
  const note = autoRetry
    ? `说明：子代理中断（${reason.trim()}），已自动重试 ${attempt}/${maxAutoRetries}，下一轮自动重新派发，无需回复。`
    : `说明：子代理中途终止，未返回结果（${reason.trim()}）。${retry ? `自动重试 ${maxAutoRetries} 次后仍未完成。` : '重试无济于事，不再自动重试。'}分支已保留；在本条下加一行「> 回复：重试」即可重新派发。`
  let next = at + 1
  if (inboxLines[next]?.startsWith('详情：')) next += 1
  if (inboxLines[next]?.startsWith('说明：')) inboxLines[next] = note
  else inboxLines.splice(next, 0, note)

  const recordLines = record.split('\n')
  const statusAt = recordLines.flatMap((line, index) => (line === 'status: 进行中' ? [index] : []))
  if (statusAt.length !== 1) throw new Error(`记录 ${id} 的 status 应恰好为「进行中」一次`)
  recordLines[statusAt[0]] = `status: ${nextStatus}`
  if (autoRetry) {
    const counterAt = recordLines.findIndex((line) => /^auto_retries:/.test(line))
    if (counterAt === -1) recordLines.splice(statusAt[0] + 1, 0, `auto_retries: ${attempt}`)
    else recordLines[counterAt] = `auto_retries: ${attempt}`
  }

  const progress = autoRetry
    ? `- ${date} · 调度者 · 中断（自动重试 ${attempt}/${maxAutoRetries}）：${reason.trim()}。状态改回待办，下一轮自动重新派发，无需负责人回复。`
    : `- ${date} · 调度者 · 中断：${reason.trim()}。${retry ? `自动重试 ${maxAutoRetries} 次已用尽` : '重试无济于事，不再自动重试'}，状态改为失败，待负责人回复后重新派发。`
  const resultAt = recordLines.indexOf('## 结果')
  if (resultAt === -1) recordLines.push('', progress)
  else {
    let insertAt = resultAt
    while (insertAt > 0 && recordLines[insertAt - 1] === '') insertAt -= 1
    recordLines.splice(insertAt, 0, progress)
  }
  return { inbox: inboxLines.join('\n'), record: recordLines.join('\n') }
}

if (isMain(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const retry = !args.includes('--no-retry')
    const [id, reason] = args.filter((arg) => arg !== '--no-retry')
    // 状态只在主检出里改；在需求工作树里运行也改主检出那份。
    const root = mainRoot()
    const { maxAutoRetries } = readConfig(root)
    const inboxFile = path.join(root, paths.inbox)
    const recordDir = path.join(root, paths.records)
    const matches = readdirSync(recordDir).filter((name) => name.startsWith(`${id}-`) && name.endsWith('.md'))
    if (matches.length !== 1) throw new Error(`inbox/ 中应恰好有一个 ${id}-*.md，实际 ${matches.length} 个`)
    const recordFile = path.join(recordDir, matches[0])
    const updated = interruptText({
      inbox: readFileSync(inboxFile, 'utf8'),
      record: readFileSync(recordFile, 'utf8'),
      id,
      reason,
      date: new Date().toLocaleDateString('sv-SE'),
      retry,
      maxAutoRetries,
    })
    writeFileSync(inboxFile, updated.inbox)
    writeFileSync(recordFile, updated.record)
    console.log(`已把 ${id} 标为${/^status:\s*(\S+)/m.exec(updated.record)?.[1]}：${path.relative(root, recordFile)} 与 INBOX.md`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
