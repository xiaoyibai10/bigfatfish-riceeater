# 形象素材来源与授权说明

本目录下的「大肥鱼娘」形象素材采用 **CC BY-NC-SA 4.0** 授权，**不属于代码的 MIT 许可范围**。

## 授权信息

- **形象授权**：CC BY-NC-SA 4.0（署名—非商业性使用—相同方式共享 4.0 国际）
- **协议全文（中文）**：<https://creativecommons.org/licenses/by-nc-sa/4.0/legalcode.zh-hans>
- **协议摘要**：<https://creativecommons.org/licenses/by-nc-sa/4.0/deed.zh-hans>

## 署名（Attribution）

根据素材页标注：

| 角色 | 署名 |
| --- | --- |
| 原作「溟月」 | @上善无形 |
| DeepSeek 形象 | @ZipZipPipe |
| 二创 | @这个刀子真甜 |

- 原始素材下载地址：<https://fisharchive.cc/character-art/v1/download/deepseek-chibi.webp>
- 获取日期：2026-11-05
- 我们未对人物设定、配色或画风做重新绘制；只做了展示所需的裁切与缩放。

## 本仓库中的文件

| 文件 | 用途 | 规格 | 说明 |
| --- | --- | --- | --- |
| `deepseek-chibi.webp` | Popup 主界面立绘 | 941 × 1672 WebP | 原始素材 |
| `deepseek-chibi-avatar.webp` | Header 圆形头像、图标生成输入 | 640 × 640 WebP | 由立绘裁切（裁切区域 x=160, y=40, 640×640） |
| `../icons/icon16.png` 等 | 扩展图标 | 16/32/48/128 PNG | 由 `scripts/make_icons.py` 从头像生成，属于本素材的改编 |

按照 CC BY-NC-SA 4.0：

- **署名**：再分发或改编时必须保留上述原作者署名、素材来源与协议链接。
- **非商业**：不得将素材用于商业目的（包括付费产品、商业推广物料等）。
- **相同方式共享**：对素材的改编（包括本仓库里的头像裁切与图标）必须继续以 CC BY-NC-SA 4.0 授权。
- **无额外限制**：不得对素材再分发附加法律条款或技术措施限制他人按协议使用。

## 与代码许可证的关系

代码部分（`extension/**/*.js`、`extension/*.html`、`extension/manifest.json`、`api/`、`supabase/`、`scripts/`、`tests/` 等）仍按仓库根目录的 **MIT License** 授权。

**本项目整体包含 CC BY-NC-SA 4.0 的非商业素材，因此不能把整个仓库直接用于商业项目。** 如果你需要商业使用，请替换 `extension/assets/deepseek-chibi*.webp` 与由它生成的图标，换成你自己拥有版权或授权明确的素材。

## 非官方声明

该素材不是 DeepSeek 官方素材，本项目与 DeepSeek 官方无隶属或合作关系。

## 下架 / 署名更正

如果你是该素材的权利人，认为署名有误、希望补充信息或希望本项目移除该素材，请在本仓库开 Issue，我们会尽快处理。
