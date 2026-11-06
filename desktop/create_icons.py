"""Rasterize the project's existing document logo into platform app icons."""
from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).parent / "assets"
root.mkdir(exist_ok=True)
image = Image.new("RGBA", (1024, 1024))
draw = ImageDraw.Draw(image)
scale = 32
def points(values):
    return [(x * scale, y * scale) for x, y in values]
draw.rounded_rectangle((6 * scale, 3 * scale, 26 * scale, 29 * scale), radius=2 * scale, fill="#e11d48")
draw.polygon(points([(19, 3), (26, 3), (26, 10)]), fill=(0, 0, 0, 0))
draw.polygon(points([(19, 3), (19, 10), (26, 10)]), fill="#fda4af")
for y, end in ((17, 21), (21, 21), (25, 17)):
    draw.line(points([(11, y), (end, y)]), fill="white", width=2 * scale)
    for x in (11, end):
        draw.ellipse(((x - 1) * scale, (y - 1) * scale, (x + 1) * scale, (y + 1) * scale), fill="white")
image.save(root / "icon.png")
image.save(root / "icon.ico", sizes=[(n, n) for n in (16, 24, 32, 48, 64, 128, 256)])
image.save(root / "icon.icns")
