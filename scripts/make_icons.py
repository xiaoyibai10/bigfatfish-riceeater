#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
大肥鱼的白饭日记 · 扩展图标生成脚本
--------------------------------------------------------------
用 Pillow 纯手绘生成 16/32/48/128 四种尺寸的 PNG 图标：
DeepSeek 蓝渐变圆角底 + 端饭碗的白色大肥鱼。

运行：
    python scripts/make_icons.py
依赖：
    Pillow（pip install pillow）
产物：
    extension/icons/icon16.png
    extension/icons/icon32.png
    extension/icons/icon48.png
    extension/icons/icon128.png
"""
from pathlib import Path
from PIL import Image, ImageDraw

# 画布先放大 4 倍再缩小，边缘更平滑（超采样）
BASE = 512
SCALE = 4
W = BASE * SCALE

ROOT = Path(__file__).resolve().parent.parent
ICON_DIR = ROOT / "extension" / "icons"
ICON_DIR.mkdir(parents=True, exist_ok=True)

BLUE_DARK = (43, 61, 168, 255)
BLUE = (77, 107, 254, 255)
BLUE_LIGHT = (124, 154, 255, 255)
INK = (38, 53, 120, 255)
WHITE = (255, 255, 255, 255)
FISH_BODY = (247, 250, 255, 255)
FIN = (214, 226, 255, 255)
RICE = (255, 247, 220, 255)
RICE_DOT = (232, 214, 165, 255)
BLUSH = (255, 164, 186, 255)
CHOPSTICK = (201, 139, 94, 255)


def s(value: float) -> int:
    """把 512 设计稿坐标换算到超采样画布坐标。"""
    return int(round(value * SCALE))


def ellipse(draw, box, fill, outline=None, width=0):
    draw.ellipse([s(box[0]), s(box[1]), s(box[2]), s(box[3])], fill=fill, outline=outline, width=s(width))


def polygon(draw, points, fill, outline=None, width=0):
    draw.polygon([(s(x), s(y)) for x, y in points], fill=fill)
    if outline:
        draw.line([(s(x), s(y)) for x, y in points] + [(s(points[0][0]), s(points[0][1]))],
                  fill=outline, width=s(width), joint="curve")


def main():
    # ---------- 1. 渐变蓝色圆角背景 ----------
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

    draw = ImageDraw.Draw(icon)

    # 背景上的高光泡泡，增加 Q 版质感
    draw.ellipse([s(40), s(40), s(120), s(120)], fill=(255, 255, 255, 26))
    draw.ellipse([s(410), s(30), s(470), s(90)], fill=(255, 255, 255, 20))

    # ---------- 2. 鱼尾巴 / 背鳍 / 腹鳍（在身体后面） ----------
    polygon(draw, [(350, 170), (438, 108), (428, 208), (452, 258), (348, 246)],
            FIN, BLUE_DARK, 8)
    polygon(draw, [(196, 104), (246, 48), (300, 106)], FIN, BLUE_DARK, 8)
    polygon(draw, [(214, 296), (252, 356), (298, 298)], FIN, BLUE_DARK, 8)

    # ---------- 3. 鱼身体 ----------
    ellipse(draw, (124, 74, 388, 330), FISH_BODY, BLUE_DARK, 12)
    # 身体上半部高光
    draw.arc([s(160), s(104), s(360), s(268)], start=200, end=330,
             fill=(255, 255, 255, 210), width=s(16))

    # ---------- 4. 眼睛、腮红、嘴 ----------
    # 大眼睛：白底 + 深色瞳孔 + 高光
    ellipse(draw, (170, 168, 244, 242), WHITE, BLUE_DARK, 8)
    ellipse(draw, (190, 188, 230, 228), INK)
    ellipse(draw, (197, 193, 211, 207), WHITE)
    # 腮红
    ellipse(draw, (150, 246, 202, 274), BLUSH)
    ellipse(draw, (320, 246, 372, 274), BLUSH)
    # 呆萌小嘴
    draw.arc([s(262), s(222), s(308), s(262)], start=10, end=170, fill=INK, width=s(9))

    # ---------- 5. 端碗的鱼鳍（手臂） ----------
    ellipse(draw, (108, 286, 192, 348), FIN, BLUE_DARK, 8)
    ellipse(draw, (326, 286, 410, 348), FIN, BLUE_DARK, 8)

    # ---------- 6. 饭碗 ----------
    # 碗身：下半圆
    draw.pieslice([s(156), s(286), s(356), s(470)], start=0, end=180,
                  fill=WHITE, outline=BLUE_DARK, width=s(12))
    # 碗口
    ellipse(draw, (146, 288, 366, 344), WHITE, BLUE_DARK, 10)
    # 米饭堆
    ellipse(draw, (178, 262, 334, 330), RICE, BLUE_DARK, 8)
    # 米粒：几颗小椭圆
    for cx, cy in [(212, 296), (244, 280), (278, 298), (306, 282), (258, 310), (230, 266)]:
        ellipse(draw, (cx - 11, cy - 7, cx + 11, cy + 7), RICE_DOT)
    # 碗底
    draw.rounded_rectangle([s(228), s(444), s(284), s(468)], radius=s(12),
                           fill=WHITE, outline=BLUE_DARK, width=s(8))
    # 碗身高光
    draw.arc([s(180), s(330), s(330), s(444)], start=40, end=120,
             fill=(214, 226, 255, 255), width=s(10))

    # ---------- 7. 筷子 ----------
    draw.line([s(330), s(300), s(420), s(128)], fill=CHOPSTICK, width=s(11))
    draw.line([s(306), s(298), s(392), s(120)], fill=CHOPSTICK, width=s(11))
    draw.ellipse([s(414), s(116), s(426), s(128)], fill=CHOPSTICK)
    draw.ellipse([s(386), s(108), s(398), s(120)], fill=CHOPSTICK)

    # ---------- 8. 输出多尺寸 ----------
    icon = icon.resize((BASE, BASE), Image.LANCZOS)
    for size in (16, 32, 48, 128):
        resized = icon.resize((size, size), Image.LANCZOS)
        out = ICON_DIR / f"icon{size}.png"
        resized.save(out, "PNG", optimize=True)
        print(f"已生成 {out.relative_to(ROOT)} ({size}x{size})")


if __name__ == "__main__":
    main()
