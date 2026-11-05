#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
大肥鱼的白饭日记 · 扩展图标生成脚本
--------------------------------------------------------------
用 Pillow 把「大肥鱼娘」头像做成 16/32/48/128 四种尺寸的 PNG：
DeepSeek 蓝渐变圆角底 + 圆形头像 + 白色描边，小尺寸下也能看清脸。

运行：
    python scripts/make_icons.py
依赖：
    Pillow（pip install pillow）
输入：
    extension/assets/deepseek-chibi-avatar.webp
产物：
    extension/icons/icon16.png
    extension/icons/icon32.png
    extension/icons/icon48.png
    extension/icons/icon128.png
"""
from pathlib import Path
from PIL import Image, ImageDraw

# 设计稿 512，超采样 4 倍后缩小，边缘更平滑
BASE = 512
SCALE = 4
W = BASE * SCALE

ROOT = Path(__file__).resolve().parent.parent
ASSET_DIR = ROOT / "extension" / "assets"
ICON_DIR = ROOT / "extension" / "icons"
AVATAR_PATH = ASSET_DIR / "deepseek-chibi-avatar.webp"

BLUE_DARK = (43, 61, 168, 255)
BLUE_LIGHT = (124, 154, 255, 255)
WHITE = (255, 255, 255, 255)

ICON_DIR.mkdir(parents=True, exist_ok=True)


def s(value: float) -> int:
    """把 512 设计稿坐标换算到超采样画布坐标。"""
    return int(round(value * SCALE))


def main():
    if not AVATAR_PATH.exists():
        raise SystemExit(f"找不到头像素材：{AVATAR_PATH}")

    # ---------- 1. 蓝色渐变圆角背景 ----------
    gradient = Image.new("RGB", (1, W))
    for y in range(W):
        t = y / max(1, W - 1)
        r = int(BLUE_DARK[0] + (BLUE_LIGHT[0] - BLUE_DARK[0]) * t)
        g = int(BLUE_DARK[1] + (BLUE_LIGHT[1] - BLUE_DARK[1]) * t)
        b = int(BLUE_DARK[2] + (BLUE_LIGHT[2] - BLUE_DARK[2]) * t)
        gradient.putpixel((0, y), (r, g, b))
    gradient = gradient.resize((W, W))

    icon = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    mask = Image.new("L", (W, W), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, W - 1, W - 1], radius=s(112), fill=255)
    icon.paste(gradient, (0, 0), mask)

    # 背景气泡高光，增加 Q 版质感
    shine = ImageDraw.Draw(icon)
    shine.ellipse([s(34), s(34), s(118), s(118)], fill=(255, 255, 255, 24))
    shine.ellipse([s(404), s(28), s(466), s(90)], fill=(255, 255, 255, 18))

    # ---------- 2. 白色圆底 ----------
    circle_draw = ImageDraw.Draw(icon)
    circle_draw.ellipse([s(36), s(36), s(476), s(476)], fill=WHITE)

    # ---------- 3. 圆形头像 ----------
    avatar = Image.open(AVATAR_PATH).convert("RGBA").resize((s(424), s(424)), Image.LANCZOS)
    avatar_mask = Image.new("L", avatar.size, 0)
    ImageDraw.Draw(avatar_mask).ellipse([0, 0, avatar.size[0] - 1, avatar.size[1] - 1], fill=255)
    avatar.putalpha(avatar_mask)
    icon.paste(avatar, (s(44), s(44)), avatar)

    # ---------- 4. 描边：蓝色外圈 + 白色内圈 ----------
    ring = ImageDraw.Draw(icon)
    ring.ellipse([s(38), s(38), s(474), s(474)], outline=(44, 63, 168, 255), width=s(7))
    ring.ellipse([s(50), s(50), s(462), s(462)], outline=(255, 255, 255, 210), width=s(3))

    # ---------- 5. 输出多尺寸 ----------
    icon = icon.resize((BASE, BASE), Image.LANCZOS)
    for size in (16, 32, 48, 128):
        resized = icon.resize((size, size), Image.LANCZOS)
        out = ICON_DIR / f"icon{size}.png"
        resized.save(out, "PNG", optimize=True)
        print(f"已生成 {out.relative_to(ROOT)} ({size}x{size})")


if __name__ == "__main__":
    main()
