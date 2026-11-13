---
name: inbox-setup
description: 在一个新仓库里安装或更新 inbox 收件箱需求流水线：问答生成 inbox.config.json，体检环境，生成 inbox、inbox-intake、inbox-idea、inbox-discover 四个技能及其脚本。支持 pi 与 Codex。用户说「安装收件箱」「inbox-setup」「给这个仓库配 inbox」或要更新收件箱配置时使用。
disable-model-invocation: true
---

# inbox-setup

You install the **inbox pipeline** into the current repository and walk the owner through its configuration. After you finish, the repository holds:

- `inbox.config.json`: the one place where project specifics live.
- `.inbox/`: scripts (claim, launch, watchdog, retry, integrate, checks), templates, a pre-commit hook. The local decision log `.inbox/decisions.tsv` is git-ignored. Requirement worktrees live outside the repo, in `../<repo>.inbox-worktrees/` by default.
- `.agents/skills/{inbox,inbox-intake,inbox-idea,inbox-discover}/`: the generated skills. pi and Codex both discover `.agents/skills/` in a project. In pi run them as `/skill:inbox`; in Codex as `$inbox`.
- `INBOX.md`, `inbox/模板.md`, `inbox/发现账本.md`, `inbox/results/`: state files, created once and never overwritten.

Talk to the owner in Chinese. Every question comes with a recommended answer so "好" accepts it. Look up facts yourself; ask only for choices.

`KIT` below is the subdirectory `kit/` inside the directory that contains this `SKILL.md` (so `KIT/scripts/doctor.mjs` sits at `<this skill's directory>/kit/scripts/doctor.mjs`). Resolve it to an absolute path first (`realpath`), since skills are often installed as symlinks. Every script prints Chinese errors that name the fix; a script that prints nothing at all has not run, so treat silence as a failure.

**Runtime.** You need network access and write access to `.git`. In Codex this means a full-access session; doctor reports a sandbox as ✗.

## Modes
- **Install** (default): the repo has no `inbox.config.json`.
- **Update**: `inbox.config.json` exists. Show the current values, ask what to change, then re-render (step 5). Use `node .inbox/scripts/render.mjs --repo .` if the repo's `.inbox/` is newer than `KIT` (`.inbox/version.json` vs `KIT/version.json`); otherwise use `KIT` so the scripts are upgraded.

## Steps

### 1. Preflight
Run `node KIT/scripts/doctor.mjs --repo . --skip-commands`. Fix or explain every ✗ before going on. Typical fixes, each needing the owner's go-ahead because they touch their repository or accounts:
- Not a git repository / no commit → offer `git init` and an initial commit.
- No remote → the pipeline needs one (branches are pushed, merges are fast-forward pushes). Ask for the remote URL; for a local trial, offer a bare repository with an **absolute** path: `git init --bare "$(cd .. && pwd)/<name>.git" && git remote add origin "$(cd .. && pwd)/<name>.git" && git push -u origin <branch>`. A relative remote path breaks inside worktrees; doctor reports it.
- Development runtime missing → install/login instructions for `codex` or `pi`.
**Done when** doctor shows no ✗ other than the config being absent.

### 2. Detect
Run `node KIT/scripts/detect.mjs --repo .`. It returns `suggested` values, the `evidence` behind them, and `questions` it could not answer. Read the README and the files it cites before trusting a suggestion; correct it where the code says otherwise.

### 3. Interview
Ask in at most two rounds, numbered, each with the recommended answer from detection. Skip a question whose answer is certain from evidence; state it as "我会用 X（依据：…）" instead. The questions, in this order:

1. **项目名与一句话产品简介** (`projectName`, `product.summary`): who uses it, for what. Discovery reads this.
2. **主要使用场景** (`product.scenarios`): 1–4 short lines in the owner's words, e.g. "早上挑衣服". Discovery checks every candidate against them.
3. **子代理交付前的检查** (`commands.check`) and **合并前的完整检查** (`commands.fullCheck`): shell commands run from the repo root; `cd sub && …` is fine. `check` must be fast enough for a subagent (minutes), `fullCheck` is the gate before anything reaches the main branch. Also `commands.install` if dependencies need installing in a fresh worktree.
4. **部署** (`deploy`):
   - `mode`: `none` (merging is the end), `push` (pushing the main branch deploys, e.g. Vercel / Netlify / a deploy workflow), or `command` (run `deploy.postMergeCommand` after merge).
   - `verify`: `none`, `github-status` (wait for the commit's GitHub statuses and checks; needs `gh`), or `command` (`deploy.verifyCommand`, `{sha}` is replaced; exit 0 success, 1 failure, other = not yet).
   - `previewCommand` (optional): builds a preview for `review` requirements and prints its URL.
   - `budget` (optional): a limit worth respecting, e.g. "Vercel 每 24 小时 100 次部署".
5. **哪些改动必须先给你看** (`review.paths`, `review.rules`): path globs (`**` any directories, `*` within one) such as database schemas, migrations, data or file formats, payment code; and plain-language rules such as "删除用户能看到的功能". Recommend the detected paths plus anything in the code that stores user data.
6. **开发子代理用什么跑** (`dev.runtime`, `dev.model`): `codex` (recommended when installed), `pi`, or `custom` (`dev.command` with `{prompt_file}`, `{worktree}`, `{last_message}` placeholders). Explain the trade-off honestly: each subagent is a separate process in its own git worktree; Codex runs it with `--dangerously-bypass-approvals-and-sandbox` because it must commit, push, and use the network, so it has full access to this machine with the owner's permissions.
7. **并发与时限** (`slots`, `subagentTimeoutMinutes`, `idleLimitMinutes`, `maxAutoRetries`): recommend 3 / 30 / 15 / 3; fewer slots on a small machine or a tight model budget. `worktreeDir` defaults to `../{repo}.inbox-worktrees` (outside the repo, so the project's own test runners and watchers do not see copies); keep it unless the parent directory is not writable.
8. **主分支守卫** (`guardMain`): recommended on. A pre-commit hook then rejects direct commits to the main branch except inbox state files; code lands through `.inbox/scripts/integrate.mjs`. The hook is local only (a fresh clone has none; `INBOX_ALLOW_MAIN_COMMIT=1` bypasses it); real protection needs branch protection on the remote. If the repo already uses `core.hooksPath` (husky) or has any hook in `.git/hooks` (e.g. git-lfs), render does not install it, so those hooks keep working: the owner adds one line to their pre-commit instead.

Other keys (`mainBranch`, `remote`, `worktreeDir`, `product.docs`, `product.glossary`, `product.roadmap`, `product.codeDirs`, `product.walkthrough`) come from detection; mention them in the summary, ask only if detection was unsure. The complete schema with defaults is `KIT/scripts/config.mjs` (`defaults`).

**Done when** every required value (`commands.check`, `commands.fullCheck`) is known and the owner has accepted the summary table.

### 4. Write and verify the config
Write `inbox.config.json` (2-space JSON, only keys that differ from defaults plus `projectName`, `commands`, `deploy`, `review`, `product`, `dev`). Then run `node KIT/scripts/doctor.mjs --repo .` **without** `--skip-commands`: it runs `commands.check` and `commands.fullCheck` once. If either fails on the untouched main branch, every future merge will fail too: help the owner fix the command or the project before continuing, or record it as a known blocker with their agreement.

### 5. Render
`node KIT/scripts/render.mjs --repo .`. It copies the kit into `.inbox/`, renders the four skills from the config, creates missing state files, adds `.gitignore` lines, and enables the pre-commit hook. Read its output; relay the hook message if it did not install the hook. Then `node .inbox/scripts/render.mjs --repo . --check` must report the files consistent.

### 6. Commit
Show `git status --short` and the list of files you will commit: `inbox.config.json`, `.inbox/` (minus ignored files), `.agents/skills/inbox*`, `INBOX.md`, `inbox/`, `.gitignore`. Stage and commit only those paths (the files are new, so stage them first):
```sh
git add -- inbox.config.json .inbox .agents/skills/inbox .agents/skills/inbox-intake .agents/skills/inbox-idea .agents/skills/inbox-discover INBOX.md inbox .gitignore
git diff --cached --name-only    # must list nothing else; unstage anything else with git restore --staged
INBOX_ALLOW_MAIN_COMMIT=1 git commit -m "chore: 安装 inbox 收件箱流水线"
```
The hook would block `.inbox/` and `.agents/` on the main branch; the variable allows this one install commit. Ask before pushing; pushing may deploy. In update mode with the hook active, make the change on a branch in its own worktree and land it by running `node .inbox/scripts/integrate.mjs` inside that worktree.

### 7. Hand over (Chinese)
Tell the owner, concretely for this repo:
- 怎么提需求：在 `INBOX.md` 的需求区写 `## 标题` 加几行描述；或运行 `inbox-intake`（pi：`/skill:inbox-intake`；Codex：`$inbox-intake`）。
- 怎么开工：运行 `inbox`（`/skill:inbox` / `$inbox`）。调度者会持续运行直到当前能做的需求都处理完；它不会因为疑问停下来等你，只在四类阻碍（预算、凭据、不可逆数据、验收无法判定）和 `review` 需求上等你。
- 想法：`inbox-idea` 随手记；`inbox-discover` 从证据里挖下一步做什么。
- 改配置：再次运行 `inbox-setup`，或改 `inbox.config.json` 后运行 `node .inbox/scripts/render.mjs --repo .`。
- 把 `node .inbox/scripts/check.mjs` 和 `node .inbox/scripts/render.mjs --repo . --check` 接进项目的 lint 或 CI（建议，不强制）。
- 安全须知（必须说）：开发子代理以完全访问权限在本机运行（Codex 用 `--dangerously-bypass-approvals-and-sandbox`），`INBOX.md` 和仓库内容会进入它的提示词；能往主分支推送内容的人，相当于能让它在你的机器上执行命令。配置里的命令（检查、部署、自定义运行时）会原样用 shell 执行。主分支守卫只在本机生效。
- 调度运行环境：Codex 里要用完全访问会话运行 `$inbox`。
- What you could not verify (for example the deploy check, which only runs on the first real merge).

## Done when
`render --check` passes, doctor shows no ✗, the install commit exists with only inbox paths, and the owner has the hand-over message.
