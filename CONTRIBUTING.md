# 贡献指南

先谢谢你看完 README 还愿意点进这个文件。大肥鱼的白饭日记是个小项目，但非常欢迎 Issue、PR、文档纠错和新的干饭梗。

## 可以贡献什么

- 🐛 **报 Bug**：在仓库的 Issues 里选择「🐛 Bug 报告」模板，按清单描述复现步骤。
- ✨ **提需求**：新成就、新交互、新的排行榜玩法都行，先开 Issue 聊一下。
- 🧹 **改代码**：修 bug、补测试、优化 UI、增加浏览器兼容。
- 📝 **改文档**：README、SPEC、FAQ 的错别字和过时描述。
- 🎨 **换素材**：如果你有授权明确的原创形象，欢迎替换当前立绘并更新 `extension/assets/ATTRIBUTION.md`。
- ⭐ **点 Star**：不写代码也能让项目多一条鱼。

## 开发环境

- Chrome 102+（扩展声明 `minimum_chrome_version: "102"`）
- Node.js 20+（跑测试与后端依赖）
- Python 3.10+ + Pillow（只在重新生成图标 / 社交预览图时需要）

## 目录速览

```text
extension/     Chrome MV3 扩展，无构建，直接加载
api/           Vercel Serverless Functions（CommonJS）
supabase/      schema.sql：建表 + 防作弊 RPC
tests/         Node 逻辑测试，不需要浏览器
docs/          SPEC、截图、发布指南
scripts/       图标与社交预览图生成脚本
```

## 本地开发

### 扩展

1. 打开 `chrome://extensions`，开启开发者模式。
2. 「加载已解压的扩展程序」选择 `extension/` 目录。
3. 修改 `extension/` 里的文件后，在扩展卡片上点刷新按钮，再点工具栏图标。

扩展是纯原生 HTML/CSS/JS，**不要**引入打包器、框架、远程脚本、`eval` 或外部字体。

### 后端（可选，只有改排行榜时才需要）

```bash
npm install
cp .env.example .env
# 在 .env 里填 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY
npx vercel dev
```

没有 Supabase 项目也可以只跑扩展的本地记账功能；缺环境变量时接口会稳定返回 `500 CONFIG_MISSING`，不会崩。

### 测试

```bash
node tests/logic.test.js
```

CI 还会跑 `node --check` 和 JSON 解析，提交前建议本地先过一遍。

## 代码约定

- UTF-8 无 BOM、LF 换行；代码注释用中文，把「为什么」写清楚。
- `extension/shared.js` 是换算、成就、存储、网络的唯一事实来源；`popup.js` 与 `background.js` 只调用 `BFF.*`，不要在 UI 层重复实现业务逻辑。
- 所有用户输入（昵称、错误信息）必须用 `textContent` 插入 DOM，禁止 `innerHTML` 拼接。
- 不提交任何 API Key、`.env`、`service_role` key、`node_modules`、`.vercel`。
- 不修改已发布成就的 `id`；新增成就请同步更新 README 成就表、`docs/SPEC.md` 和测试。
- 后端保持 CommonJS，响应必须是 JSON；错误信息不得泄露 SQL、密钥、堆栈。

## 提交信息

使用 Conventional Commits 风格，例如：

```text
feat(ui): 主界面增加今日战果气泡
fix(rank): 修复同分时我的名次计算
docs: 补充自定义域名配置说明
chore: 升级 @supabase/supabase-js
```

## PR 检查清单

- [ ] `node tests/logic.test.js` 通过
- [ ] 所有 JS 通过 `node --check`
- [ ] 在 `chrome://extensions` 里手动加载验证过（UI 改动请附截图/GIF）
- [ ] 没有提交密钥、`.env`、`node_modules`
- [ ] 行为和 `docs/SPEC.md` 一致；若不一致，SPEC 已同步更新
- [ ] 新素材有明确授权，并更新了 `extension/assets/ATTRIBUTION.md`

## 素材授权

当前吉祥物是社区二创素材，来源与授权状态见 `extension/assets/ATTRIBUTION.md`。**不要**在没有授权的情况下把新的第三方图片提交进仓库；推荐使用自己绘制、CC0 或明确授权可再分发的素材。

## 安全问题

请不要在公开 Issue 里贴 API Key 或数据库密钥。漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 行为准则

参与本项目即表示同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
