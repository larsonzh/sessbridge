#!/usr/bin/env python3
"""Generate the SessionBridge extension icon (128x128 PNG).

Pure stdlib (zlib + struct) — no Pillow required.  Concept:
two chat bubbles (sessions) joined by a bridge link, on a blue
rounded square — "session bridge".

Usage:  python tools/make_icon.py [output.png]   (default extension/icon.png)
"""

import os
import struct
import sys
import zlib

SIZE = 128
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    'extension', 'icon.png')


# ---- geometry helpers (signed-distance style, no AA for simplicity) --------
def in_rrect(px, py, x, y, w, h, r):
    if px < x or px >= x + w or py < y or py >= y + h:
        return False
    dx = px - (x + w / 2.0)
    dy = py - (y + h / 2.0)
    cx = x + w / 2.0 - r
    cy = y + h / 2.0 - r
    if abs(px - (x + w / 2.0)) > w / 2.0 - r and abs(py - (y + h / 2.0)) > h / 2.0 - r:
        pass
    # quick corner check
    qx = min(max(px, x + r), x + w - r)
    qy = min(max(py, y + r), y + h - r)
    return (px - qx) ** 2 + (py - qy) ** 2 <= r * r or (
        x + r <= px <= x + w - r and y <= py <= y + h) or (
        y + r <= py <= y + h - r and x <= px <= x + w)


def in_seg(px, py, ax, ay, bx, by, half):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    c1 = vx * wx + vy * wy
    if c1 <= 0:
        return (px - ax) ** 2 + (py - ay) ** 2 <= half * half
    c2 = vx * vx + vy * vy
    if c2 <= c1:
        return (px - bx) ** 2 + (py - by) ** 2 <= half * half
    t = c1 / c2
    dx, dy = px - (ax + t * vx), py - (ay + t * vy)
    return dx * dx + dy * dy <= half * half


def in_tri(px, py, ax, ay, bx, by, cx, cy):
    def sign(x1, y1, x2, y2, x3, y3):
        return (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3)
    d1 = sign(px, py, ax, ay, bx, by)
    d2 = sign(px, py, bx, by, cx, cy)
    d3 = sign(px, py, cx, cy, ax, ay)
    neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
    pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
    return not (neg and pos)


def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def main():
    # palette
    blue_top = (59, 130, 246)      # #3B82F6
    blue_bot = (30, 58, 138)       # #1E3A8A
    white = (255, 255, 255)
    accent = (147, 197, 253)       # #93C5FD light blue for link

    # geometry (128x128): background rounded square + two bubbles + link
    bg = (10, 10, SIZE - 10, SIZE - 10, 26)        # x,y,w,h,r
    bubble_a = (24, 30, 40, 32, 9)                 # left bubble
    bubble_b = (64, 64, 40, 32, 9)                 # right bubble
    # tails (small triangles under each bubble): flat ax,ay,bx,by,cx,cy
    tail_a = (38, 62, 30, 76, 50, 62)
    tail_b = (78, 96, 70, 110, 90, 96)
    # bridge link: thick segment between bubbles + two dots
    link_a = (46, 52)
    link_b = (84, 76)

    rows = []
    for py in range(SIZE):
        row = bytearray()
        for px in range(SIZE):
            # default transparent
            r, g, b, a = 0, 0, 0, 0
            t = (py - bg[1]) / float(bg[3])
            t = max(0.0, min(1.0, t))
            if in_rrect(px, py, *bg[:5]):
                r, g, b = lerp(blue_top, blue_bot, t)
                a = 255
                # bubbles / tails / link painted on top
                if in_rrect(px, py, *bubble_a[:5]) or \
                   in_rrect(px, py, *bubble_b[:5]) or \
                   in_tri(px, py, *tail_a) or in_tri(px, py, *tail_b):
                    r, g, b = white
                elif in_seg(px, py, link_a[0], link_a[1],
                            link_b[0], link_b[1], 4):
                    r, g, b = accent
                elif ((px - link_a[0]) ** 2 + (py - link_a[1]) ** 2) <= 6 ** 2 or \
                     ((px - link_b[0]) ** 2 + (py - link_b[1]) ** 2) <= 6 ** 2:
                    r, g, b = white
            rows.append(struct.pack('4B', r, g, b, a))
        # row is per-pixel already appended in order

    raw = b''.join(rows)
    # PNG encode
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', SIZE, SIZE, 8, 6, 0, 0, 0)
    # filter byte 0 for each scanline
    scan = b''.join(b'\x00' + raw[i * SIZE * 4:(i + 1) * SIZE * 4]
                    for i in range(SIZE))
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
           chunk(b'IDAT', zlib.compress(scan, 9)) + chunk(b'IEND', b''))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'wb') as f:
        f.write(png)
    print('wrote %s (%d bytes)' % (OUT, len(png)))


if __name__ == '__main__':
    main()
