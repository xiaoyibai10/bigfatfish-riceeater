# 发布到 GitHub · 操作手册

这份文档面向第一次把项目挂到 GitHub 的维护者。照着做即可，不需要先学 Git。

> ⚠️ **发布前必须确认的两件事**：
> 1. 形象素材采用 **CC BY-NC-SA 4.0**：公开仓库时必须保留原作者署名、素材来源与协议链接；**禁止商业使用**；改编（头像、图标）必须同协议共享。代码是 MIT，但整个仓库不能直接商用。
> 2. 本项目由 AI 生成 / AI 辅助生成：README 首屏、Release Notes 和仓库 About 都要明确说明「AI 生成」，不能只靠代码注释。

## 0. 发布前检查（3 分钟）

```bash
cd bigfatfish-riceeater

# 1. 测试通过
node tests/logic.test.js

# 2. 所有 JS 语法通过
find extension api tests -name '*.js' -print0 | xargs -0 -n1 node --check

# 3. 没有密钥
git grep -n -E 'sk-[A-Za-z0-9]{20,}|SUPABASE_SERVICE_ROLE_KEY=.*[A-Za-z0-9]' || echo "没有发现疑似密钥"

# 4. 工作区干净
git status
```

预期：最后一条显示 `nothing to commit, working tree clean`。如果还有未提交改动，先 `git add -A && git commit -m "chore: ..."`。

## 1. 仓库里已经有什么

- `README.md`：完整的项目介绍（首屏截图、slogan、AI 生成声明、徽章、成就表、安装、API、防作弊、隐私、FAQ、免责声明、双许可证）
- `LICENSE`：MIT（只覆盖代码；形象素材是 CC BY-NC-SA 4.0，见 `extension/assets/ATTRIBUTION.md`）
- `.gitignore` / `.gitattributes`：忽略 `.env`、`node_modules`，统一 LF
- `.env.example`
- `extension/`、`api/`、`supabase/`、`tests/`、`scripts/`
- `docs/`：SPEC、三张真实截图、发布说明
- Git 提交历史与 `v1.1.0` tag

## 2. 这次补齐的 GitHub 配套文件

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/ci.yml` | 每次 push / PR 自动跑语法检查与 27 项逻辑测试 |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | 结构化的 Bug 模板，提醒不要贴 Key |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | 功能建议模板 |
| `.github/pull_request_template.md` | PR 检查清单 |
| `.github/dependabot.yml` | 每周检查 npm 与 Actions 依赖更新 |
| `CONTRIBUTING.md` | 贡献指南、开发环境、PR 规范 |
| `SECURITY.md` | 漏洞报告流程与安全边界 |
| `CODE_OF_CONDUCT.md` | 社区行为准则 |
| `CHANGELOG.md` | 版本变更记录 |
| `docs/PUBLISH_TO_GITHUB.md` | 本文件 |
| `docs/RELEASE_NOTES_v1.1.0.md` | GitHub Release 文案模板 |
| `docs/social-preview.png` | GitHub 仓库社交预览图（1280×640） |

## 3. 创建 GitHub 仓库

### 方式 A：网页创建（推荐新手，不需要装工具）

1. 登录 <https://github.com>，点右上角 **+ → New repository**。
2. **Repository name** 填 `bigfatfish-riceeater`。
3. **Description** 先贴上：
   > 读取 DeepSeek API 余额，把消耗换算成白饭（0.1 元 = 1 碗），带 16 个赛博干饭人成就与匿名排行榜的 Chrome MV3 扩展（AI 生成项目）。
4. 选择 **Public**（仓库已标注 CC BY-NC-SA 4.0 与 AI 生成声明）或 **Private**。
5. **不要**勾选 "Add a README file"、"Add .gitignore"、"Choose a license"——本地已经全部有了，勾了会冲突。
6. 点 **Create repository**，复制页面上的仓库地址，形如：
   `https://github.com/xiaoyibai10/bigfatfish-riceeater.git`

### 方式 B：使用 GitHub CLI（装了 `gh` 的话）

```bash
gh auth login
gh repo create bigfatfish-riceeater --public --source=. --remote=origin --push
git push origin v1.1.0
```

如果 `gh` 没安装，用方式 A 即可。

## 4. 推送本地代码

在 `bigfatfish-riceeater` 目录里执行（下面的 `xiaoyibai10` 已经按你的 GitHub 用户名填好；如果仓库名不同，同步替换）：

> 先执行 `git remote -v`。如果已经能看到 `origin https://github.com/xiaoyibai10/bigfatfish-riceeater.git`，就**跳过** `git remote add`，否则会报 `remote origin already exists`。

```bash
# 如果还没有配置 Git 身份
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"

# 仅在还没有 origin 时执行；已有则跳过
git remote add origin https://github.com/xiaoyibai10/bigfatfish-riceeater.git

# 确认当前分支叫 main（GitHub 默认也是 main）
git branch -M main

# 第一次推送
git push -u origin main

# 推送 v1.1.0 标签
git push origin v1.1.0
```

成功后刷新 GitHub 页面，应该能看到 README、三张截图、扩展代码和绿色的 CI 小勾。

> 如果你之前已经加过 remote，用 `git remote set-url origin <新地址>` 修改；用 `git remote -v` 查看当前地址。

## 5. 仓库 About 怎么写（介绍文档的第一层）

GitHub 仓库首页右上角的 **About** 是最短的门面，建议：

**Description（中文，约 70 字）**

```text
读取 DeepSeek API 余额，把消耗换算成白饭（0.1 元 = 1 碗），带 16 个赛博干饭人成就与匿名排行榜的 Chrome MV3 扩展（AI 生成项目）。
```

**Description（英文备选）**

```text
An AI-generated Chrome MV3 extension that turns DeepSeek API spending into rice bowls (¥0.1 = 1 bowl), with 16 achievements and an anonymous leaderboard. Code: MIT; mascot art: CC BY-NC-SA 4.0.
```

**Topics（逐个粘贴）**

```text
chrome-extension
manifest-v3
deepseek
deepseek-api
api-balance
supabase
vercel
gamification
leaderboard
javascript
ai-generated
```

**Website**：留空即可（没有在线 Demo 就不要写，避免“打不开的演示站”）。

**Social preview**：上传 `docs/social-preview.png`（1280×640，仓库已生成）。

## 6. README 怎么写（介绍文档的第二层）

`README.md` 就是 GitHub 上真正的介绍文档，不需要再单独写一份“项目介绍”。当前 README 的首屏结构已经按开源项目习惯排好：

1. **一张真实截图** + 项目名 + 一句话 slogan
2. **徽章**：AI Generated / Manifest V3 / Vercel / Supabase / MIT (code) / CC BY-NC-SA 4.0 (art)
3. **一句话定位**：不是财务工具，是赛博打工人的干饭体检报告
4. **AI 生成声明**：代码、文档、测试由 AI 生成 / 辅助生成，使用前自行审阅
5. **功能特性**（emoji 列表）
6. **三张截图** + 吐槽文案
7. **16 个成就表**（和代码一致）
8. **快速开始**：Supabase → Vercel → 加载扩展 → 填 Key
9. **环境变量、API 文档、项目结构、防作弊、隐私、FAQ、免责声明、双许可证**

写开源 README 的三条经验：

- **首屏必须能“看懂 + 想试”**：截图、slogan、3 步安装，别把目录放在最上面。
- **说清楚边界**：非官方、AI 生成、0.1 元是玩梗、API Key 只存本地、形象素材 CC BY-NC-SA 4.0（禁止商用）。
- **不要写不存在的东西**：没上架 Chrome Web Store、没有在线 Demo、没有用户量，就别写；开源项目最忌讳“README 吹得比代码多”。

如果以后想在 README 顶部加 CI 徽章，等仓库地址确定后用：

```markdown
![CI](https://github.com/xiaoyibai10/bigfatfish-riceeater/actions/workflows/ci.yml/badge.svg)
```

## 7. 发布 v1.1.0 Release

1. 确认标签已推送：`git push origin v1.1.0`。
2. GitHub 仓库 → **Releases → Draft a new release**。
3. **Choose a tag** 选 `v1.1.0`，**Release title** 填：
   ```text
   v1.1.0 · 大肥鱼娘来了
   ```
4. **Describe this release** 粘贴 `docs/RELEASE_NOTES_v1.1.0.md` 的内容；图片 URL 已经用的是 `xiaoyibai10`，如果你改了仓库名/用户名记得同步替换。
5. 可选：把 `bigfatfish-riceeater-v1.1.0.zip` 拖进 **Attach binaries**。
6. 点 **Publish release**。

Release 页面是介绍文档的第三层：给已经安装旧版的人看“这次改了什么、怎么升级、有什么坑”。

## 8. 发布后建议开启的设置

- **Settings → Actions → General**：确认 Actions 允许运行（CI 需要）。
- **Settings → Code security**：开启 **Private vulnerability reporting**（`SECURITY.md` 里引用了这个入口）、Dependabot alerts。
- **Branches**：给 `main` 加一条规则，要求 CI 通过才能合并（个人项目可选）。
- **Issues**：确认模板生效；在 `SECURITY.md` 里提醒不要公开贴 Key。
- **Pin repository**：在个人主页把项目 pin 上去，增加曝光。

## 9. 常见问题

### `remote origin already exists`

说明 remote 已经配置过，不用再执行 `git remote add`。先看当前地址：

```bash
git remote -v
```

- 地址正确：直接 `git push -u origin main`。
- 地址错了：`git remote set-url origin https://github.com/xiaoyibai10/bigfatfish-riceeater.git`。

### `Repository not found` / 仓库 404

用浏览器打开 `https://github.com/xiaoyibai10/bigfatfish-riceeater`：

1. **打不开**：仓库还没创建，先去 <https://github.com/new> 新建，名称必须是 `bigfatfish-riceeater`，不要勾选初始化 README / .gitignore / License。
2. **能打开但推送仍 404**：本地登录的 GitHub 账号不是 `xiaoyibai10`，或仓库是 Private 但当前凭据没有权限。检查 `git remote -v` 的地址、GitHub 当前登录账号和仓库可见性。
3. **仓库名不一致**：用 `git remote set-url origin <正确地址>` 改掉，再推。

也可以直接查公开 API 确认：

```bash
curl -s https://api.github.com/repos/xiaoyibai10/bigfatfish-riceeater
```

返回 `"Not Found"` 说明公开仓库不存在（Private 仓库在未认证时也会返回 Not Found）。

### 仓库创建时勾了 README，推送被拒绝

```bash
git pull --rebase --allow-unrelated-histories origin main
git push -u origin main
```

如果冲突，保留本地 README，解决后 `git add -A && git rebase --continue`。

### `TLS certificate verification has been disabled!`

这条警告说明 Git 全局关闭了 HTTPS 证书校验（`git config --global http.sslVerify false`）。推送时可能会弹浏览器登录，**但关闭证书校验有凭据被中间人截获的风险**。建议：

```bash
# 先确认当前的设置
git config --show-origin --get http.sslVerify

# 恢复校验（如果证书链本身有问题，恢复后会直接报 SSL 错误）
git config --global --unset http.sslVerify
```

如果恢复后无法连接（公司代理 / 自签证书环境），更安全的做法是改用 SSH：

```bash
ssh-keygen -t ed25519 -C "你的邮箱"
# 把 ~/.ssh/id_ed25519.pub 加到 GitHub → Settings → SSH and GPG keys
git remote set-url origin git@github.com:xiaoyibai10/bigfatfish-riceeater.git
git push -u origin main
```

或者使用 GitHub Desktop，不要长期关闭 HTTPS 证书校验。

### `remote: Permission denied` / `Authentication failed`

GitHub 不再接受账号密码推送。用 Personal Access Token（Settings → Developer settings → Personal access tokens）或安装 GitHub CLI 后 `gh auth login`。不要把 token 写进仓库。

### `src refspec main does not match any`

本地分支可能还叫 `master`。执行 `git branch -M main` 再推。

### 推送后 README 图片不显示

确认 `docs/screenshot-*.png` 和 `extension/assets/*.webp` 已经提交（`git ls-files docs extension/assets`），并且路径大小写一致。GitHub 是大小写敏感的。

### GitHub Actions 没跑

看 **Actions** 标签页是否启用；fork 的仓库首次运行可能需要手动点 **I understand my workflows, go ahead and enable them**。

### 想改仓库名

GitHub 会自动重定向旧地址，但 README 里如果写了绝对链接需要手动改。本项目 README 全部用相对路径，改名不影响。

### 图片太大 / 被 GitHub 拒绝

本项目图片总共约 1.5 MB，远低于 100 MB 单文件限制，不需要 Git LFS。

## 10. 最后检查清单

- [ ] 形象素材 CC BY-NC-SA 4.0 的署名、协议链接、非商业提示已展示
- [ ] README / Release / About 都写明了「AI 生成」
- [ ] `git status` 干净
- [ ] 测试通过、CI 绿
- [ ] About 描述 / Topics / Social preview 已填
- [ ] v1.1.0 tag 与 Release 已发布
- [ ] README 首屏截图能正常显示
- [ ] 没有 `.env`、API Key、`service_role` key
- [ ] 没有 `node_modules`、`.vercel`
- [ ] 免责声明与素材授权说明可见
