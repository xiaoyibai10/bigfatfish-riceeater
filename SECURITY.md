# 安全策略

## 支持版本

| 版本 | 是否接收安全修复 |
| --- | --- |
| 1.1.x | ✅ |
| 1.0.x | ❌（建议升级到最新版） |

## 报告安全问题

**请不要在公开 Issue 里粘贴任何密钥、API Key、`service_role` key 或完整 `.env` 内容。**

优先使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告（仓库建好后需要先在 Settings 里开启 Private vulnerability reporting）。如果暂时没有开启，也可以开一个不含敏感信息的 Issue，只写「需要私下联系」，维护者会再和你对接。

报告时请尽量包含：

- 受影响的版本（`manifest.json` 里的 version）
- 复现步骤与预期结果
- 影响范围（本地数据 / 排行榜 / 后端 / 扩展权限）
- 必要的日志或截图，**先打码 Key、UUID、数据库地址**

## 在范围内的漏洞

- 扩展越权读取/上传用户数据、API Key 泄露
- `chrome.storage.local` 数据被恶意页面读取
- 后端 `service_role` 泄露、CORS 配置导致越权写入
- Supabase RLS / `report_rank` 权限绕过、SQL 注入
- 排行榜防作弊逻辑可被简单绕过（不是指「改前端数字」这种必然能改的展示层）
- 依赖供应链问题（`@supabase/supabase-js` 等）

## 不在范围内

- DeepSeek 官方 API 的计费、可用性、Key 封禁等问题（请找 DeepSeek 官方）
- 用户自己把 API Key 发到群里、截图里、公开仓库里
- 排行榜昵称的内容纠纷（昵称是用户自己填的）
- 社会工程、物理访问、浏览器本身的 0day

## 响应方式

这是个人开源项目，维护者会尽量在 **72 小时内**确认收到，并在修复后于 Release Notes / Security Advisory 中说明。请不要在修复发布前公开细节。

## 用户侧加固建议

- API Key 只保存在本机 `chrome.storage.local`，不要截图分享设置页。
- `SUPABASE_SERVICE_ROLE_KEY` 只放 Vercel 环境变量，不写进扩展、不提交 Git。
- 怀疑 Key 泄露时，去 DeepSeek 开放平台吊销并重建；怀疑 service_role 泄露时，去 Supabase 轮换。
- 从官方仓库 / Release 页面获取扩展，不使用来路不明的二次打包版本。
