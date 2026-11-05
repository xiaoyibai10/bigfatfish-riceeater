# v1.1.0 · 大肥鱼娘来了

> 把 DeepSeek 的余额烧成白饭，现在这条鱼有脸了。

![主界面](https://raw.githubusercontent.com/xiaoyibai10/bigfatfish-riceeater/main/docs/screenshot-main.png)

## 本次更新

- 🎨 **吉祥物替换**：手写 SVG 大肥鱼 → 蓝发鲸尾的「大肥鱼娘」社区二创立绘。
- 🖼️ **头像与图标**：Header 改为圆形头像，扩展图标重新生成 16/32/48/128 四种尺寸。
- 📐 **主界面调整**：立绘改为半身裁切 + 底部渐隐，380×580 Popup 内数据卡片与刷新按钮完整可见。
- 📊 **干饭榜修复**：「我的排名」卡片移到榜单上方，不再遮挡列表。
- 📝 **文档更新**：README / SPEC / 项目结构 / 素材授权说明同步更新，并补充 AI 生成声明。
- 📦 **发行包**：`bigfatfish-riceeater-v1.1.0.zip`。

## 🤖 AI 生成声明

本项目的扩展代码、Vercel API、Supabase SQL、测试、脚本、文档与文案由 AI 编程助手在人工需求、审核与测试下生成 / 辅助生成；扩展图标由脚本从授权的二创立绘生成。请在使用前自行审阅代码与配置，AI 生成内容可能存在错误或安全疏漏。

## 🎨 形象授权

- 授权：**CC BY-NC-SA 4.0**（署名—非商业性使用—相同方式共享 4.0 国际）
- 署名：原作「溟月」@上善无形 · DeepSeek 形象 @ZipZipPipe · 二创 @这个刀子真甜
- 协议：<https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.zh-hans>
- 图片不适用 MIT 代码许可，**禁止商业使用**，改编需同协议共享；详见 `extension/assets/ATTRIBUTION.md`。
- 代码部分仍为 MIT；但整个仓库包含非商业素材，不能直接用于商业项目。

## 安装 / 升级

1. 下载仓库或 Release 附件。
2. `chrome://extensions` → 开发者模式 → 加载已解压的扩展程序 → 选 `extension/`。
3. 已有安装直接替换文件后，在扩展卡片上点刷新。
4. 排行榜需要自己部署 Vercel + Supabase，并在设置里填写后端地址。

## 验证

- `node tests/logic.test.js`：27 / 27 通过
- 全部 JS `node --check` 通过
- 静态检查：资源引用、manifest 图标、README 图片、UTF-8 / LF、无密钥
- 三张 README 截图由无头 Edge 实际渲染

## 注意

- 项目非 DeepSeek 官方项目；0.1 元 = 1 碗是玩梗换算。
- API Key 只保存在本地，请勿截图分享；排行榜昵称请勿使用真名。
