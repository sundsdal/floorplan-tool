# /// script
# requires-python = ">=3.12"
# dependencies = ["pillow>=11,<13"]
# ///
"""Render two repeatable first-person clips of the same synthetic apartment."""
import math
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
WIDTH, HEIGHT, FPS = 320, 200, 10
# Plan coordinates in metres. The shared wall at x=3 has a 1 m opening.
WALLS = [
    ((0, 0), (3, 0), (230, 228, 220)),
    ((3, 0), (5, 0), (172, 143, 105)),
    ((5, 0), (5, 4), (192, 156, 115)),
    ((5, 4), (3, 4), (153, 113, 86)),
    ((3, 4), (0, 4), (218, 233, 229)),
    ((0, 4), (0, 0), (203, 221, 228)),
    ((3, 0), (3, 1), (234, 230, 229)),
    ((3, 2), (3, 4), (234, 230, 229)),
]


def frame(x, y, angle):
    image = Image.new("RGB", (WIDTH, HEIGHT), "#d7d7d1")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, HEIGHT // 2, WIDTH, HEIGHT), fill="#847668")
    for col in range(WIDTH):
        offset = math.atan((col + 0.5 - WIDTH / 2) / 180)
        dx, dy = math.cos(angle + offset), math.sin(angle + offset)
        hits = []
        for (ax, ay), (bx, by), color in WALLS:
            wx, wy = bx - ax, by - ay
            det = dx * wy - dy * wx
            if abs(det) < 1e-8:
                continue
            t = ((ax - x) * wy - (ay - y) * wx) / det
            along = ((ax - x) * dy - (ay - y) * dx) / det
            if t > 0 and 0 <= along <= 1:
                hits.append((t, along * math.hypot(wx, wy), color))
        if not hits:
            continue
        dist, along, color = min(hits)
        scale = 180 / (dist * math.cos(offset))
        top, bottom = 100 - scale * 0.9, 100 + scale * 1.5
        shade = max(0.64, 1 - dist * 0.045)
        if along % 0.5 < 0.012:
            shade *= 0.8
        rgb = tuple(int(c * shade) for c in color)
        draw.line((col, top, col, bottom), fill=rgb)
        for row in range(1, 5):
            h = bottom - row * 0.5 * scale
            draw.point((col, int(h)), fill=tuple(int(c * 0.85) for c in rgb))
    return image


def render(name, seconds, camera):
    args = ["ffmpeg", "-loglevel", "error", "-y", "-f", "rawvideo",
            "-pixel_format", "rgb24", "-video_size", f"{WIDTH}x{HEIGHT}",
            "-framerate", str(FPS), "-i", "-", "-c:v", "libx264",
            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(OUT / name)]
    with subprocess.Popen(args, stdin=subprocess.PIPE) as encoder:
        for i in range(seconds * FPS):
            encoder.stdin.write(frame(*camera(i / (seconds * FPS - 1))).tobytes())
        encoder.stdin.close()
        if encoder.wait():
            raise RuntimeError(f"Failed to encode {name}")


if __name__ == "__main__":
    # Cut before crossing the threshold; the second clip supplies the connection.
    render("first-sweep.mp4", 32, lambda t: (1.5, 2.4, t * math.tau)
           if t < 0.68 else (4.2, 2.7, math.pi * (1.2 + t)))
    render("doorway-return.mp4", 8, lambda t: (4.4 - 3 * t, 1.5, math.pi))
