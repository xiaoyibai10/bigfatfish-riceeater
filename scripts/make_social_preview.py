#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 GitHub 仓库的社交预览图（1280×640）。
--------------------------------------------------------------
输入：
    docs/screenshot-main.png
输出：
    docs/social-preview.png
依赖：
    Pillow（pip install pillow）
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SHOT_PATH = ROOT / "docs" / "screenshot-main.png"
OUT_PATH = ROOT / "docs" / "social-preview.png"

WIDTH, HEIGHT = 1280, 640
BLUE = (77, 107, 254)
BLUE_DARK = (43, 61, 168)
YELLOW = (255, 184, 77)

FONT_BOLD = "C:/Windows/Fonts/msyhbd.ttc"
FONT_REGULAR = "C:/Windows/Fonts/msyh.ttc"


def load_font(path: str, size: int):
    """加载中文字体；Windows 上没有该字体时给出明确提示。"""
    try:
        return ImageFont.truetype(path, size)
    except OSError as error:
        raise SystemExit(f"找不到字体 {path}，请修改 FONT_BOLD / FONT_REGULAR 后重试。") from error


def main():
    if not SHOT_PATH.exists():
        raise SystemExit(f"找不到截图：{SHOT_PATH}，先运行扩展并截图到该路径。")

    # ---------- 1. 深蓝渐变背景 ----------
    background = Image.new("RGB", (WIDTH, HEIGHT))
    pixels = background.load()
    for y in range(HEIGHT):
        t = y / max(1, HEIGHT - 1)
        r = int(BLUE_DARK[0] + (BLUE[0] - BLUE_DARK[0]) * t)
        g = int(BLUE_DARK[1] + (BLUE[1] - BLUE_DARK[1]) * t)
        b = int(BLUE_DARK[2] + (BLUE[2] - BLUE_DARK[2]) * t)
        for x in range(WIDTH):
            pixels[x, y] = (r, g, b)
    background = background.convert("RGBA")

    # 柔光气泡，避免纯色背景太死板
    glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse([-160, -220, 420, 360], fill=(255, 255, 255, 26))
    glow_draw.ellipse([980, -180, 1420, 260], fill=(255, 255, 255, 18))
    glow_draw.ellipse([-100, 520, 360, 900], fill=(255, 184, 77, 22))
    background = Image.alpha_composite(background, glow)

    # ---------- 2. 右侧截图 + 圆角 + 投影 ----------
    screenshot = Image.open(SHOT_PATH).convert("RGBA")
    shot_height = 560
    shot_width = round(screenshot.width * shot_height / screenshot.height)
    screenshot = screenshot.resize((shot_width, shot_height), Image.LANCZOS)

    shot_mask = Image.new("L", (shot_width, shot_height), 0)
    ImageDraw.Draw(shot_mask).rounded_rectangle(
        [0, 0, shot_width - 1, shot_height - 1], radius=24, fill=255
    )
    screenshot.putalpha(shot_mask)

    shot_x = WIDTH - shot_width - 68
    shot_y = (HEIGHT - shot_height) // 2

    shadow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.rounded_rectangle(
        [shot_x - 8, shot_y - 8, shot_x + shot_width + 8, shot_y + shot_height + 8],
        radius=34,
        fill=(9, 19, 60, 150),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(20))
    background = Image.alpha_composite(background, shadow)
    background.alpha_composite(screenshot, (shot_x, shot_y))

    draw = ImageDraw.Draw(background)

    # 截图白边
    draw.rounded_rectangle(
        [shot_x - 3, shot_y - 3, shot_x + shot_width + 2, shot_y + shot_height + 2],
        radius=26,
        outline=(255, 255, 255, 220),
        width=4,
    )

    # ---------- 3. 左侧文案 ----------
    title_font = load_font(FONT_BOLD, 64)
    slogan_font = load_font(FONT_BOLD, 32)
    body_font = load_font(FONT_REGULAR, 22)
    small_font = load_font(FONT_REGULAR, 18)

    # 黄色短装饰线
    draw.rounded_rectangle([78, 156, 84, 246], radius=3, fill=YELLOW)

    draw.text((108, 140), "大肥鱼的白饭日记", font=title_font, fill=(255, 255, 255))
    draw.text((112, 238), "0.1 元 = 1 碗白饭", font=slogan_font, fill=(255, 224, 170))
    draw.text((112, 300), "把 DeepSeek 的 API 消耗，", font=body_font, fill=(235, 241, 255))
    draw.text((112, 332), "翻译成一条鱼吃掉的饭。", font=body_font, fill=(235, 241, 255))
    draw.text((112, 392), "16 个赛博干饭人成就 · 匿名排行榜", font=body_font, fill=(235, 241, 255))

    # 底部小字
    draw.text((112, 520), "AI 生成  ·  代码 MIT  ·  形象 CC BY-NC-SA 4.0", font=small_font, fill=(210, 223, 255))

    # 右下角小气泡装饰
    draw.ellipse([120, 470, 128, 478], fill=(255, 184, 77, 220))
    draw.ellipse([146, 456, 152, 462], fill=(255, 255, 255, 140))

    background.convert("RGB").save(OUT_PATH, "PNG", optimize=True)
    print(f"已生成 {OUT_PATH}（{WIDTH}×{HEIGHT}）")


if __name__ == "__main__":
    main()
