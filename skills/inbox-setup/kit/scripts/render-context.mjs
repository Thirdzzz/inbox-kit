// 把 inbox.config.json 换成技能模板里用的变量。模板只认这里给出的名字，缺一个就报错，不会悄悄生成空白。
import { blockerTags, inboxMarker, paths, statuses } from './config.mjs'

const bullets = (items, empty = '（无）') => (items.length ? items.map((item) => `- ${item}`).join('\n') : `- ${empty}`)
const code = (items) => items.map((item) => `\`${item}\``).join('、')

export function skillContext(config) {
  const { commands, deploy, review, product, dev } = config
  const mainRef = `${config.remote}/${config.mainBranch}`
  return {
    project: config.projectName || '本项目',
    mainBranch: config.mainBranch,
    remote: config.remote,
    mainRef,
    worktreeDir: config.worktreeDir,
    slots: config.slots,
    maxRetries: config.maxAutoRetries,
    idleLimit: config.idleLimitMinutes,
    timeLimit: config.subagentTimeoutMinutes,
    checkCommand: commands.check,
    fullCheck: commands.fullCheck,
    installCommand: commands.install,
    hasInstall: Boolean(commands.install),
    devRuntime: dev.runtime,
    devModel: dev.model || '（运行时默认模型）',
    // 部署
    deployNone: deploy.mode === 'none',
    deployPush: deploy.mode === 'push',
    deployCommand: deploy.mode === 'command',
    postMergeCommand: deploy.postMergeCommand,
    verifies: deploy.verify !== 'none',
    verifyMode: deploy.verify,
    hasPreview: Boolean(deploy.previewCommand),
    previewCommand: deploy.previewCommand,
    hasBudget: Boolean(deploy.budget),
    budget: deploy.budget,
    shippedMeaning: deploy.mode === 'none' ? `已合入 \`${config.mainBranch}\`（本项目没有自动部署）` : '已合入并确认部署',
    // 强制检查
    hasReviewPaths: review.paths.length > 0,
    reviewPaths: code(review.paths),
    reviewRules: bullets(review.rules, '没有额外规则'),
    hasReviewRules: review.rules.length > 0,
    // 产品
    summary: product.summary || '（配置里没有写产品简介；发现需求前先补上 product.summary）',
    hasDocs: product.docs.length > 0,
    docs: code(product.docs),
    hasGlossary: Boolean(product.glossary),
    glossary: product.glossary,
    hasRoadmap: Boolean(product.roadmap),
    roadmap: product.roadmap,
    hasScenarios: product.scenarios.length > 0,
    scenarios: bullets(product.scenarios),
    codeDirs: product.codeDirs.length ? code(product.codeDirs) : '整个仓库',
    hasWalkthrough: Boolean(product.walkthrough),
    walkthrough: product.walkthrough,
    // 固定约定
    marker: inboxMarker,
    statuses: statuses.map((s) => `\`${s}\``).join('、'),
    blockerTags: blockerTags.map((t) => `\`[${t}]\``).join('、'),
    ledger: paths.ledger,
    decisionLog: paths.decisionLog,
    guardMain: config.guardMain,
    ci: config.ci,
  }
}
