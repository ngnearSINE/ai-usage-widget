"""앱·트레이 아이콘을 제목줄 기호(막대 세 개, dashboard.css의 .app-symbol)와 같은 모양으로 만든다.

- public/icon.ico·icon.png: 설치 파일·실행 파일·시작 메뉴·알림·Linux. 정보 창 로고처럼 어두운 둥근 사각형 위에 막대.
- public/tray-icon.ico·tray-icon.png: 트레이. 제목줄처럼 배경 없이 막대만. 밝은 작업 표시줄에서도 보이게
  반투명 대신 불투명한 색으로 막대마다 진하기만 다르게 한다.

막대 비율은 .app-symbol과 같다: 너비 3, 간격 2, 높이 7·13·9(불투명도 .55·1·.8), 전체 13×13.
작은 크기에서도 번지지 않게 막대 좌표를 정수 픽셀에 맞추고 8배로 그린 뒤 줄인다.
실행: python tools/make-icons.py (Pillow 필요)
"""
from pathlib import Path
from PIL import Image, ImageDraw

ACCENT = (169, 155, 255)  # 기본 강조색 #a99bff
TILE = (38, 37, 55)       # 강조색 14%를 어두운 바탕에 섞은 색(정보 창 로고 바탕)
SS = 8
PUBLIC = Path(__file__).resolve().parent.parent / 'public'


def draw(size: int, tile: bool) -> Image.Image:
    big = Image.new('RGBA', (size * SS, size * SS), (0, 0, 0, 0))
    g = ImageDraw.Draw(big)
    if tile:
        g.rounded_rectangle((0, 0, size * SS - 1, size * SS - 1), radius=round(size * .22 * SS), fill=TILE + (255,))
    glyph = size * (.56 if tile else .875)
    u = glyph / 13
    w, gap = max(1, round(3 * u)), max(1, round(2 * u))
    hs = [max(2, round(h * u)) for h in (7, 13, 9)]
    total = 3 * w + 2 * gap
    x = (size - total) // 2
    base = (size + hs[1]) // 2
    for h, a in zip(hs, (.55, 1, .8)):
        fill = tuple(round(c * a + t * (1 - a)) for c, t in zip(ACCENT, TILE)) + (255,) if tile else tuple(round(c * (.72 + .28 * a)) for c in ACCENT) + (255,)
        g.rounded_rectangle((x * SS, (base - h) * SS, (x + w) * SS - 1, base * SS - 1), radius=w * SS / 3, fill=fill)
        x += w + gap
    # 투명 가장자리가 밝게 번지지 않도록 미리 곱한 알파(RGBa)로 줄인다.
    return big.convert('RGBa').resize((size, size), Image.LANCZOS).convert('RGBA')


def ico(path: Path, sizes, tile: bool):
    imgs = [draw(s, tile) for s in sizes]
    imgs[-1].save(path, format='ICO', sizes=[(s, s) for s in sizes], append_images=imgs[:-1])


ico(PUBLIC / 'icon.ico', [16, 24, 32, 48, 64, 128, 256], True)
draw(256, True).save(PUBLIC / 'icon.png')
ico(PUBLIC / 'tray-icon.ico', [16, 20, 24, 32, 40, 48], False)
draw(32, False).save(PUBLIC / 'tray-icon.png')
print('ok')
