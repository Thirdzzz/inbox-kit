// 追加一条决策记录到 .inbox/decisions.tsv（本地文件，不进版本库）。每条一行，五个字段都不能含制表符或换行。
// 用法：node .inbox/scripts/log-decision.mjs <阶段> <决策> <原因> <证据> <结果>
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { isMain, mainRoot, paths } from './config.mjs'

export const header = '时间\t阶段\t决策\t原因\t证据\t结果\n'

// 电子表格会把 = + - @ 开头的单元格当公式，前面加单引号。
const cell = (value) => (/^[=+\-@"]/.test(value) ? `'${value}` : value)

export function buildRow(fields, timestamp = new Date().toISOString()) {
  if (fields.length !== 5) throw new Error(`需要恰好 5 个参数，收到 ${fields.length} 个。每个字段用引号包成一个参数：node .inbox/scripts/log-decision.mjs "<阶段>" "<决策>" "<原因>" "<证据>" "<结果>"`)
  const labels = ['阶段', '决策', '原因', '证据', '结果']
  fields.forEach((value, index) => {
    if (!value?.trim()) throw new Error(`「${labels[index]}」不能为空`)
    if (/[\t\r\n]/.test(value)) throw new Error(`「${labels[index]}」不能包含制表符或换行`)
  })
  return [timestamp, ...fields].map(cell).join('\t') + '\n'
}

if (isMain(import.meta.url)) {
  try {
    const row = buildRow(process.argv.slice(2))
    const file = path.join(mainRoot(), paths.decisionLog)
    mkdirSync(path.dirname(file), { recursive: true })
    if (!existsSync(file)) appendFileSync(file, header)
    appendFileSync(file, row)
    console.log(`已追加决策记录：${process.argv[2]}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 2
  }
}
