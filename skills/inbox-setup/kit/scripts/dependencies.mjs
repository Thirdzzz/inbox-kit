// 校验需求记录的 depends_on：编号存在、没有循环；输出每条需求还被哪些未上线的依赖挡着。
// 用法：node .inbox/scripts/dependencies.mjs [记录目录]
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { checkoutRoot, isMain, paths } from "./config.mjs"

export function parseDependencies(value) {
  const text = value.trim()
  if (text === '""' || text === "''" || text === '[]') return []
  const scalar = /^['"](\d{3})['"]$/.exec(text)
  if (scalar) return [scalar[1]]
  if (!/^\[(?:\s*['"]\d{3}['"]\s*(?:,\s*['"]\d{3}['"]\s*)*)?\]$/.test(text)) throw new Error(`无效的 depends_on：${text}`)
  const ids = [...text.matchAll(/['"](\d{3})['"]/g)].map((match) => match[1])
  if (new Set(ids).size !== ids.length) throw new Error(`重复的 depends_on：${text}`)
  return ids
}

export function validateDependencies(records) {
  const byId = new Map(records.map((record) => [record.id, record]))
  if (byId.size !== records.length) throw new Error('存在重复的需求编号')
  const visiting = new Set()
  const visited = new Set()
  function visit(id) {
    if (visiting.has(id)) throw new Error(`依赖循环涉及 ${id}`)
    if (visited.has(id)) return
    const record = byId.get(id)
    if (!record) throw new Error(`找不到依赖需求 ${id}`)
    visiting.add(id)
    for (const dependency of record.dependsOn) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of byId.keys()) visit(id)
  return records.map((record) => ({
    id: record.id,
    status: record.status,
    blockers: record.dependsOn.filter((id) => byId.get(id).status !== '已上线').map((id) => ({ id, status: byId.get(id).status })),
  }))
}

export function readRecords(directory) {
  return readdirSync(directory)
    .filter((name) => /^\d{3}-.*\.md$/.test(name))
    .map((name) => {
      const content = readFileSync(path.join(directory, name), 'utf8')
      const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1]
      if (!frontmatter) throw new Error(`${name} 缺少元数据`)
      const field = (key) => new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'm').exec(frontmatter)?.[1]
      const id = /^['"]?(\d{3})['"]?$/.exec(field('id') ?? '')?.[1]
      const status = field('status')?.replace(/^['"]|['"]$/g, '')
      const depends = field('depends_on')
      if (!id || id !== name.slice(0, 3) || !status) throw new Error(`${name} 的编号或状态无效`)
      return { id, status, dependsOn: depends === undefined ? [] : parseDependencies(depends) }
    })
}

if (isMain(import.meta.url)) {
  try {
    const directory = process.argv[2] ?? path.join(checkoutRoot(), paths.records)
    console.log(JSON.stringify(validateDependencies(readRecords(directory)), null, 2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
