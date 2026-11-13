# inbox-kit

把「在 INBOX.md 里写需求，Agent 分诊、开发、合并」这条流水线装进任意 Git 仓库。支持 pi 和 Codex。

## 安装技能

二选一：

```sh
# 软链接到用户级技能目录（pi 和 Codex 都会扫描 ~/.agents/skills）
ln -s /Users/third/repos/experiments/inbox-kit/skills/inbox-setup ~/.agents/skills/inbox-setup

# 或作为 pi 包安装
pi install /Users/third/repos/experiments/inbox-kit
```

## 在一个仓库里启用

在目标仓库里运行一次安装技能：

- pi：`/skill:inbox-setup`
- Codex：`$inbox-setup`（要用完全访问会话，沙箱里不能联网、不能写 `.git`）

它会先体检仓库，再问 8 个问题（产品简介、检查命令、部署方式、需要人工审阅的路径、开发子代理用哪个运行时等），然后生成：

| 生成物 | 作用 |
|---|---|
| `inbox.config.json` | 全部配置，改完运行 `node .inbox/scripts/render.mjs --repo .` 重新生成 |
| `.inbox/` | 脚本、模板、提交钩子 |
| `.agents/skills/inbox*` | 四个技能（只能显式调用） |
| `INBOX.md`、`inbox/` | 需求区与需求记录 |

需求工作树默认放在仓库外的 `../<仓库名>.inbox-worktrees/`。

## 日常使用

| 想做的事 | pi | Codex |
|---|---|---|
| 把一句话整理成需求条目 | `/skill:inbox-intake` | `$inbox-intake` |
| 随手记一个想法 | `/skill:inbox-idea` | `$inbox-idea` |
| 让 Agent 根据项目证据找下一步 | `/skill:inbox-discover` | `$inbox-discover` |
| 分诊并开发 INBOX.md 里的需求 | `/skill:inbox` | `$inbox` |

也可以直接在 `INBOX.md` 的需求区写 `## 标题` 和几行描述。命中审阅路径的需求会停在「待检查」，在条目下写 `> 回复：通过` 或 `> 回复：打回：原因`。

## 安全须知

- 开发子代理以完全访问权限在本机运行（Codex 用 `--dangerously-bypass-approvals-and-sandbox`，pi 本身没有沙箱）。`INBOX.md` 和仓库内容会进入它的提示词：能往主分支推送内容的人，相当于能让它在你的机器上执行命令。
- 配置里的命令（检查、部署、确认、自定义运行时）会原样交给 shell 执行。
- 主分支守卫是本机提交钩子，`INBOX_ALLOW_MAIN_COMMIT=1` 或新克隆都能绕过。真正的保护要在远端开启分支保护。
- 合并门禁（检查命令、越权规则）一律取自主检出，需求分支改不了；需求分支改动 `.inbox/`、`inbox.config.json` 或 inbox 技能会被拒绝合并。

## 开发本仓库

```sh
node --test test/*.test.mjs
```

kit 的源文件在 `skills/inbox-setup/kit/`；`skills/inbox-setup/SKILL.md` 是安装技能本身。
