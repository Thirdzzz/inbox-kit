// 生成开发子代理的任务说明（提示词）。由 launch.mjs start 调用，也可单独运行查看：
//   node .inbox/scripts/brief.mjs <NNN> [--note "<附加说明>"]
// 附加说明用于重试：写上一次中断的原因、分支已提交到哪一步、这次要怎么缩小范围；或负责人「打回」的理由。
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { argValue, blockerTags, isMain, mainRoot, paths, readConfig, worktreePath } from './config.mjs'

export function buildBrief(config, { id, worktree, recordFile, note = '' }) {
  const tags = blockerTags.map((t) => `[${t}]`).join('、')
  const glossary = config.product.glossary ? `、\`${config.product.glossary}\`` : ''
  const install = config.commands.install ? `先运行 \`${config.commands.install}\` 安装依赖，然后` : ''
  return `你是需求 ${id} 的开发子代理。没有人会回答你的问题：遇到疑问自己做保守决定，记下来，然后继续。

## 工作位置
- 你的工作目录是 \`${worktree}\`（分支 \`inbox/${id}\`）。只在这个目录里读写文件、执行命令；不要切换分支，不要碰别的工作树或主检出。
- 先读：仓库的 \`AGENTS.md\`（如有）${glossary}、需求记录 \`${recordFile}\`，以及记录里列出的要改的文件。如果记录里有依赖（depends_on），依赖已经在 \`${config.mainBranch}\` 上了。

## 怎么做
1. ${install}按验收标准先写测试，再实现。只改这条需求需要的内容，不顺手重构。
2. 交付前跑检查：\`${config.commands.check}\`，再跑 \`node .inbox/scripts/check.mjs\`（它会拒绝改动收件箱状态文件和流水线自身的分支）。失败就修，最多修 2 轮。不要跑合并前的完整检查（\`${config.commands.fullCheck}\`），那是调度者合并时的事。
3. 给每条命令设上限：单条命令不要超过约 10 分钟；开发服务器、监听进程不要放在前台。一条命令卡住就算这一步失败。
4. 每完成一步可用的进展就提交并推送：\`git add <明确路径> && git commit -m "wip: <中文说明>" && git push -u ${config.remote} inbox/${id}\`。你可能在 ${config.subagentTimeoutMinutes} 分钟时被停掉，或在 ${config.idleLimitMinutes} 分钟没有动静时被判为卡死；推送过的进度下次重试可以接着做。范围太大时，先做满足验收标准的最小版本。
5. 正式提交信息用 \`feat:\` / \`fix:\` / \`test:\` / \`docs:\` 开头，后面写中文。全部通过后最后推送一次。

## 只写自己的结果文件
- 进展和结果只写 \`${paths.results}/${id}.md\`（不存在就新建），格式：
  \`\`\`
  返回：ready
  ## 进展记录
  - 时间 · 子代理 · 做了什么
  ## 结果
  - 改了什么：
  - 怎么验证的：（列出实际跑过的命令和结果）
  - 没有验证的：（真机、真实数据、人工观感等）
  - 提交：
  - 假设：（你替负责人做的每个决定，一条一行）
  ## 追问
  （只有返回 needs-info 时才写）
  \`\`\`
- 不要改 \`${paths.inbox}\`、\`${paths.ideas}\`、\`${paths.records}/NNN-*.md\`（归调度者），也不要改 \`.inbox/\`、\`inbox.config.json\`、\`.agents/skills/inbox*\`（流水线自身）。越权的分支不会被合并。
- 不要读取或修改与本需求无关的、工作树以外的文件。

## 返回值（写在结果文件第一行，也作为你最后一句话）
- \`返回：ready\`：检查全部通过，已推送。
- \`返回：needs-info\`：只用于只有负责人能解决的阻碍，每个问题前带一个标签：${tags}。设计、范围、措辞、测试方法上的疑问不算阻碍：选和记录、现有代码一致的保守做法，写成「假设：…」，继续做。
- \`返回：failed\`：写清楚试过什么、卡在哪、下次该怎么改。调度者会自动重试。
${note.trim() ? `\n## 这一次的附加说明\n${note.trim()}\n` : ''}`
}

if (isMain(import.meta.url)) {
  const [id] = process.argv.slice(2)
  try {
    const root = mainRoot()
    const config = readConfig(root)
    const records = readdirSync(path.join(root, paths.records)).filter((name) => name.startsWith(`${id}-`) && name.endsWith('.md'))
    if (records.length !== 1) throw new Error(`inbox/ 中应恰好有一个 ${id}-*.md，实际 ${records.length} 个`)
    const worktree = worktreePath(root, config, id)
    if (!existsSync(worktree)) throw new Error(`没有工作树 ${worktree}`)
    process.stdout.write(buildBrief(config, { id, worktree, recordFile: `${paths.records}/${records[0]}`, note: argValue(process.argv.slice(2), '--note') ?? '' }))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
