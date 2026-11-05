# Changelog

本项目重要变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [1.1.0] - 2026-11-05

### Changed

- 吉祥物由手写 SVG 大肥鱼替换为「大肥鱼娘」社区二创立绘（蓝发、鲸鱼尾巴、女仆装）。
- Header 改用圆形头像；扩展图标改为蓝底圆形头像，重新生成 16/32/48/128 四种尺寸。
- 主界面立绘改为半身裁切 + 底部渐隐，保证 380×580 Popup 内数据卡片和刷新按钮完整可见。
- 干饭榜的「我的排名」卡片调整到榜单上方，避免 sticky 卡片遮挡列表。
- README、`docs/SPEC.md`、项目结构树同步更新。
- 新增 `extension/assets/ATTRIBUTION.md`，记录形象素材来源与授权状态。

### Fixed

- 修复干饭榜列表在底部滚动时被「我的排名」卡片遮挡的问题。

### Added

- 发布 v1.1.0 归档包与 Git tag。
- GitHub 开源配套：CI workflow、Dependabot、Issue / PR 模板、`CONTRIBUTING.md`、`SECURITY.md`、`CODE_OF_CONDUCT.md`、`CHANGELOG.md`、发布手册与 1280×640 社交预览图。

## [1.0.0] - 2026-11-05

### Added

- Chrome MV3 扩展：DeepSeek API 余额查询、0.1 元 = 1 碗白饭换算、今日 / 累计 / 连续干饭统计。
- 16 个成就（财富阶级 6、连吃天数 3、特殊事件 4、排行榜互动 3）与成就墙。
- `chrome.alarms` 定时刷新、图标角标、成就 Toast。
- 匿名排行榜：Vercel Serverless API + Supabase 数据库 + 5 分钟 / 500 碗防作弊 RPC。
- 设置页：API Key、昵称、参榜开关、刷新间隔、后端地址、测试连接、清空数据。
- 单元测试、图标生成脚本、README、Supabase 建表 SQL、Vercel 配置。
