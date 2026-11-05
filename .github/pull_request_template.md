# Pull Request

## 这个 PR 做了什么

<!-- 用一两句话说明改动和原因 -->

## 类型

- [ ] 🐛 Bug 修复
- [ ] ✨ 新功能
- [ ] 🎨 UI / 交互
- [ ] 📝 文档
- [ ] 🧪 测试
- [ ] 🔧 构建 / 配置 / CI

## 关联 Issue

<!-- 例如 Closes #12，没有就写“无” -->

## 验证方式

- [ ] `node tests/logic.test.js` 通过
- [ ] 所有 JS 通过 `node --check`
- [ ] 已在 `chrome://extensions` 手动加载验证
- [ ] 后端改动已本地调用过接口（或说明未验证原因）

## 截图 / GIF（UI 改动必填）

<!-- 拖入截图即可 -->

## 检查清单

- [ ] 没有提交 API Key、`.env`、`service_role` key、`node_modules`
- [ ] 所有用户输入仍使用 `textContent` 插入，没有引入 XSS
- [ ] 成就 id / 存储字段没有破坏性改名
- [ ] 行为变化已同步 `docs/SPEC.md` 和 README
- [ ] 新素材有明确授权，并更新了 `extension/assets/ATTRIBUTION.md`
- [ ] 提交信息符合 Conventional Commits
