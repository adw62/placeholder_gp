#!/usr/bin/env python3
"""Livery painter: carkit JSON -> the 'synthetic photos' a generated car is
textured from, in the style of the Sonnet-painted scene(7)/scene(11) cars
(flat GT1-era liveries: split two-tone body with a swooshed accent pinstripe,
shadowed rocker, roundel numbers on door/hood/roof, sponsor decals at several
scales, windshield team banner, painted headlights/grille/taillights,
windows/arches PAINTED into the side view rather than modeled, subtle
hue-preserving grain).

    python3 tools/paint-car.py <kit.json>

Writes work/cars/<id>.textures/{side_right,side_left,wrap}.png. build-car.js
invokes this automatically when the kit has a `livery` block, then wires
every face as a real Scene Forge photo grab with exact handles into these
images — so each face stays fully hand-editable afterward.

PIXEL CONVENTIONS (build-car.js computes grab handles against these — keep in sync):
  side_*  : W=1024, MARGIN=32. scale=(W-2*MARGIN)/length (same for y).
            side_right: nose (zFrac 0) at LEFT edge; side_left: nose at RIGHT.
            (In the game frame — +Z nose, Y up, right-handed — an exterior
            view of the +X flank puts the nose on the screen LEFT; painting
            it the intuitive way round renders every glyph mirrored.)
            y_px = MARGIN + (maxY - y) * scale.
  wrap    : W=768, H=1536. y_px = arc/total * (H-1), arc measured around the
            silhouette loop in sil order (top nose->tail, then bottom
            tail->nose), starting at sil[0] = top[0]. x: car RIGHT (+x) at
            x=0, LEFT at W-1.
"""
import json, math, random, sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-Bold.ttf"

SIDE_W, MARGIN = 1024, 32
WRAP_W, WRAP_H = 768, 1536


def font(px):
    return ImageFont.truetype(FONT, px)


def grain(img, amt=7, seed=11):
    """Hue-preserving per-pixel grain (same delta on R,G,B) — the established
    placeholder-art look (addGrain in placeholders.js), baked into the photo."""
    rnd = random.Random(seed)
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            d = rnd.randint(-amt, amt)
            r, g, b = px[x, y][:3]
            px[x, y] = (max(0, min(255, r + d)), max(0, min(255, g + d)), max(0, min(255, b + d)))
    return img


def hx(c):
    c = c.lstrip("#")
    return tuple(int(c[i : i + 2], 16) for i in (0, 2, 4))


def centered_text(d, xy, text, f, fill):
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    d.text((xy[0] - (r - l) / 2 - l, xy[1] - (b - t) / 2 - t), text, font=f, fill=fill)


def text_tile(img, xy, text, f, fill, sx=1.0, rot180=False):
    """Text pasted as a tile: optionally stretched horizontally (the wrap
    image's px/m differs between x and y — sx makes glyphs physically square
    on the car) and optionally rotated 180° (hood/windshield lettering reads
    from the NOSE; the wrap's +y runs nose→tail, so upright-in-image text
    comes out backwards there)."""
    d = ImageDraw.Draw(img)
    l, t, r, b = d.textbbox((0, 0), text, font=f)
    tile = Image.new("RGBA", (r - l + 4, b - t + 4), (0, 0, 0, 0))
    ImageDraw.Draw(tile).text((2 - l, 2 - t), text, font=f, fill=fill)
    if sx != 1.0:
        tile = tile.resize((max(1, int(tile.width * sx)), tile.height))
    if rot180:
        tile = tile.rotate(180)
    img.paste(tile, (int(xy[0] - tile.width / 2), int(xy[1] - tile.height / 2)), tile)


def topY(top, zf):
    """Piecewise-linear roofline height at zFrac."""
    if zf <= top[0][0]:
        return top[0][1]
    for k in range(1, len(top)):
        if zf <= top[k][0]:
            a, b = top[k - 1], top[k]
            u = (zf - a[0]) / (b[0] - a[0])
            return a[1] + (b[1] - a[1]) * u
    return top[-1][1]


def classify(a, b, L):
    """Same strip naming as build-car.js stripName (top-polyline edges only)."""
    dz = abs(b[0] - a[0]) * L
    slope = float("inf") if dz < 1e-6 else abs(b[1] - a[1]) / dz
    mid = (a[0] + b[0]) / 2
    if slope > 1.2:
        return "nose" if mid < 0.5 else "tail"
    if slope >= 0.35:
        return "windshield" if mid < 0.5 else "rearglass"
    return "hood" if mid < 0.35 else ("deck" if mid > 0.72 else "roof")


def chain_kinds(top, L):
    """Chain-level sanitization (mirror of carlib.js chainKinds): a car has ONE
    cabin — keep only the glass runs touching the highest roof run, relabel
    stray glass-classified segments as hood/deck (nose/tail if near-vertical)."""
    kinds = [classify(top[k], top[k + 1], L) for k in range(len(top) - 1)]

    def steep(i):
        dz = abs(top[i + 1][0] - top[i][0]) * L
        return (float("inf") if dz < 1e-6 else abs(top[i + 1][1] - top[i][1]) / dz) > 1.2

    runs, cur = [], None
    for i, k in enumerate(kinds):
        if k == "roof":
            cur = cur or [i, i]
            cur[1] = i
        elif cur:
            runs.append(cur); cur = None
    if cur:
        runs.append(cur)
    if not runs:
        return kinds
    mid_y = lambda i: (top[i][1] + top[i + 1][1]) / 2
    best = max(runs, key=lambda r: sum(mid_y(i) for i in range(r[0], r[1] + 1)) / (r[1] - r[0] + 1))
    glass = ("windshield", "rearglass")
    # glass runs touching the roof ARE the windshield / rear glass, whichever
    # side of mid-car the raw slope classifier thought they were on
    w0 = best[0]
    while w0 > 0 and kinds[w0 - 1] in glass:
        w0 -= 1
    for i in range(w0, best[0]):
        kinds[i] = "windshield"
    g1 = best[1]
    while g1 < len(kinds) - 1 and kinds[g1 + 1] in glass:
        g1 += 1
    for i in range(best[1] + 1, g1 + 1):
        kinds[i] = "rearglass"
    for i in range(w0):
        if kinds[i] in glass or kinds[i] == "roof":
            kinds[i] = "nose" if steep(i) else "hood"
    for i in range(g1 + 1, len(kinds)):
        if kinds[i] in glass or kinds[i] == "roof":
            kinds[i] = "tail" if steep(i) else "deck"
    return kinds


def paint_side(kit, lv, mirrored):
    L = kit["length"]
    top, bottom = kit["sideProfile"]["top"], kit["sideProfile"]["bottom"]
    ys = [y for _, y in top + bottom]
    max_y, min_y = max(ys), min(ys)
    scale = (SIDE_W - 2 * MARGIN) / L
    H = math.ceil(2 * MARGIN + (max_y - min_y) * scale)

    def X(zf):  # nose at LEFT for the right-hand side view (see header)
        x = MARGIN + zf * L * scale
        return x if not mirrored else (SIDE_W - x)

    def Y(y):
        return MARGIN + (max_y - y) * scale

    body, stripe, accent = hx(lv.get("bodyColor", "#dfe3ea")), hx(lv.get("stripeColor", "#b02030")), hx(lv.get("accent", "#1a2a6e"))
    glass = hx(lv.get("windowColor", "#141a24"))
    img = Image.new("RGB", (SIDE_W, H), body)
    d = ImageDraw.Draw(img)

    floor_y = min(y for _, y in bottom)
    # beltline = the actual windshield-base height (a fixed zf samples partway
    # up the glass on cars whose windshield starts early, pushing the whole
    # side-window band too high)
    kinds = chain_kinds(top, L)
    seg = [(top[k], top[k + 1], kinds[k]) for k in range(len(top) - 1)]
    cab = [s for s in seg if s[2] in ("windshield", "roof", "rearglass")]
    belt_y = (topY(top, cab[0][0][0]) if cab else topY(top, 0.35)) + 0.01

    # --- split livery (the scene(7)/(11) look): bodyColor above the split
    # line, stripeColor below, darker-shaded rocker for depth, and an accent
    # pinstripe riding the split. The line starts high at the tail and sweeps
    # monotonically down toward the nose — never back up.
    span = belt_y - floor_y  # split sits proportionally in the painted body band
    ctrl = [(0.0, floor_y + span * 0.30), (0.35, floor_y + span * 0.38),
            (0.7, floor_y + span * 0.48), (1.0, floor_y + span * 0.62)]

    def split_y(zf):
        if zf <= ctrl[0][0]:
            return ctrl[0][1]
        for k in range(1, len(ctrl)):
            if zf <= ctrl[k][0]:
                a, b = ctrl[k - 1], ctrl[k]
                u = (zf - a[0]) / (b[0] - a[0])
                return a[1] + (b[1] - a[1]) * u
        return ctrl[-1][1]

    steps = 48
    path = [(X(k / steps), Y(split_y(k / steps))) for k in range(steps + 1)]
    d.polygon(path + [(X(1.0), H), (X(0.0), H)], fill=stripe)
    # rocker panel: shadowed version of the lower color
    d.rectangle([0, Y(floor_y + 0.045), SIDE_W, H], fill=tuple(int(c * 0.55) for c in stripe))
    # accent pinstripe along the split
    d.line(path, fill=accent, width=max(3, int(0.02 * scale)), joint="curve")

    # cabin side glass: a trapezoid under the ROOF span only — glass wedges
    # run up the windshield/rear-glass make the greenhouse read as four
    # windows instead of two. Front/rear edges rake along the pillars; a
    # body-colored B-pillar splits it into door + quarter windows.
    roof = [s for s in seg if s[2] == "roof"]
    if cab:
        z0, z1 = cab[0][0][0], cab[-1][1][0]  # full glasshouse footprint (seams below)
        zr0, zr1 = (roof[0][0][0], roof[-1][1][0]) if roof else (z0 + 0.3 * (z1 - z0), z1 - 0.3 * (z1 - z0))
        # sill = the HIGHER of the two glass bases — side windows must not
        # reach below the bottom of the windshield or the rear window
        sill = max(topY(top, z0), topY(top, z1)) + 0.01
        fr, rr = zr0 - 0.6 * (zr0 - z0), zr1 + 0.6 * (z1 - zr1)  # raked pillar feet
        steps = 10
        pts = [(X(fr), Y(sill))]
        for k in range(steps + 1):
            zf = zr0 + (zr1 - zr0) * k / steps
            pts.append((X(zf), Y(topY(top, zf) - 0.04)))
        pts.append((X(rr), Y(sill)))
        d.polygon(pts, fill=glass)
        # B-pillar: front door window gets ~45% of the cabin
        zb = fr + 0.45 * (rr - fr)
        d.rectangle(
            [min(X(zb - 0.012), X(zb + 0.012)), Y(topY(top, zb) - 0.03), max(X(zb - 0.012), X(zb + 0.012)), Y(sill)],
            fill=body)

    # wheel arches — wheels are separate rig geometry; the arch is painted
    wheels = kit.get("wheels", {})
    arch_r = 0.19 * scale
    for wz in (wheels.get("frontZ", 0.72), wheels.get("rearZ", -0.7)):
        zf = 0.5 - wz / L
        cx, cy = X(zf), Y(floor_y)
        d.ellipse([cx - arch_r, cy - arch_r, cx + arch_r, cy + arch_r], fill=(16, 18, 22))

    # roundel + number between the arches — big, spanning the split line
    num = str(lv.get("number", 1))
    zf_f, zf_r = 0.5 - wheels.get("frontZ", 0.72) / L, 0.5 - wheels.get("rearZ", -0.7) / L
    cx = X((zf_f + zf_r) / 2)
    cy = (Y(belt_y) + Y(floor_y + 0.05)) / 2
    r = min(46.0, (Y(floor_y) - Y(belt_y)) * 0.46)
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(245, 245, 242), outline=accent, width=4)
    centered_text(d, (cx, cy), num, font(int(r * 1.3)), (18, 18, 22))
    # small scrutineering number at the nose
    centered_text(d, (X(0.05), Y(belt_y - 0.055)), num, font(17), (20, 20, 24))

    # sponsor decals: zone-based, auto-fit. The white band above the split is
    # divided by the roundel into a front and a rear panel; each sponsor is
    # centered in its panel and shrunk until it fits, so placement stays
    # sensible on any silhouette (nothing crowds the roundel or spills off
    # the ends). Small print sits on the rocker between the arches.
    sponsors = lv.get("sponsors", ["TIRE CO.", "HUBWORKS", "PACER BRAKES"])
    high_cy = (Y(belt_y) + Y(split_y(0.5))) / 2  # middle of the white band
    mid = (zf_f + zf_r) / 2
    r_zf = (r / scale + 0.04) / L
    arch_zf = (arch_r / scale + 0.03) / L

    def fit(text, zone_w_px, start):
        f = start
        while f > 12:
            l, t, rr_, b = d.textbbox((0, 0), text, font=font(f))
            if rr_ - l <= zone_w_px * 0.9:
                break
            f -= 1
        return font(f)

    zones = [  # (zf0, zf1, y, start font, color)
        (0.08, mid - r_zf, high_cy, 24, stripe),
        (mid + r_zf, 0.97, high_cy, 22, stripe),
        (zf_f + arch_zf, zf_r - arch_zf, Y(floor_y + 0.012), 14, (235, 235, 235)),
    ]
    for (za, zb_, ty, fs, col), text in zip(zones, sponsors):
        w_px = (zb_ - za) * L * scale
        centered_text(d, (X((za + zb_) / 2), ty), text, fit(text, w_px, fs), col)

    # panel seams: hood/windshield boundary + door edges
    if cab:
        for zf in (z0, (z0 + z1) / 2 - 0.17, z1 + 0.02):
            d.line([X(zf), Y(belt_y - 0.01), X(zf), Y(floor_y + 0.05)], fill=tuple(int(c * 0.8) for c in body), width=1)

    return grain(img, seed=7 if mirrored else 11)


def paint_wrap(kit, lv):
    L = kit["length"]
    top, bottom = kit["sideProfile"]["top"], kit["sideProfile"]["bottom"]
    sil = list(top) + list(reversed(bottom))
    n = len(sil)
    # cumulative arc around the loop, kit meters (matches build-car.js)
    S = [0.0]
    for k in range(n):
        a, b = sil[k], sil[(k + 1) % n]
        S.append(S[-1] + math.hypot((b[0] - a[0]) * L, b[1] - a[1]))
    total = S[-1]

    def Yarc(s):
        return s / total * (WRAP_H - 1)

    body, stripe = hx(lv.get("bodyColor", "#dfe3ea")), hx(lv.get("stripeColor", "#b02030"))
    accent, glass = hx(lv.get("accent", "#1a2a6e")), hx(lv.get("windowColor", "#141a24"))
    img = Image.new("RGB", (WRAP_W, WRAP_H), body)
    d = ImageDraw.Draw(img)

    kinds_top = chain_kinds(top, L)
    kinds = []
    for k in range(n):
        a, b = sil[k], sil[(k + 1) % n]
        if k < len(top) - 1:
            kind = kinds_top[k]
        elif k == len(top) - 1:
            kind = "tail"
        elif k == n - 1:
            kind = "nose"
        else:
            kind = "floor"
        kinds.append((kind, Yarc(S[k]), Yarc(S[k + 1])))

    # contiguous same-kind bands merge FIRST: glass fills+trim per merged run
    # (per-band trim draws a divider mid-window), decals once per panel
    merged = []
    for kind, y0, y1 in kinds:
        if merged and merged[-1][0] == kind:
            merged[-1][2] = y1
        else:
            merged.append([kind, y0, y1])
    # floor + glass bands first, then stripes over paint (not over glass), then decals
    for kind, y0, y1 in merged:
        if kind == "floor":
            d.rectangle([0, y0, WRAP_W, y1], fill=(31, 36, 44))
        elif kind in ("windshield", "rearglass"):
            d.rectangle([0, y0, WRAP_W, y1], fill=glass)
            d.rectangle([0, y0, WRAP_W, y0 + 4], fill=tuple(int(c * 0.6) for c in body))
            d.rectangle([0, y1 - 4, WRAP_W, y1], fill=tuple(int(c * 0.6) for c in body))
    # twin racing stripes down the painted top (nose..deck), skipping glass/floor
    sw = WRAP_W * 0.09
    for kind, y0, y1 in kinds:
        if kind in ("hood", "roof", "deck", "nose", "tail"):
            for cx in (WRAP_W / 2 - sw * 0.75, WRAP_W / 2 + sw * 0.75):
                d.rectangle([cx - sw / 2, y0, cx + sw / 2, y1], fill=stripe)

    num = str(lv.get("number", 1))
    team = lv.get("team", "PLACEHOLDER GP")
    sponsors = lv.get("sponsors", ["TIRE CO.", "HUBWORKS", "PACER BRAKES"])
    # physical-unit drawing: the wrap is ~3× denser across the car (x) than
    # along the arc (y), so anything drawn square in pixels renders squished
    # on the car. Sizes below are METERS, converted per axis.
    width = kit.get("width", 1.7)
    pxm_x, pxm_y = (WRAP_W - 1) / width, (WRAP_H - 1) / total
    sx = pxm_x / pxm_y  # horizontal glyph stretch → physically square text

    def wtext(xy, text, h_m, fill, rot180=False):
        text_tile(img, xy, text, font(max(10, int(h_m * pxm_y))), fill, sx=sx, rot180=rot180)

    def roundel(cx, cy, r_m):
        rx, ry = r_m * pxm_x, r_m * pxm_y
        d.ellipse([cx - rx, cy - ry, cx + rx, cy + ry], fill=(245, 245, 242), outline=accent, width=4)

    for kind, y0, y1 in merged:
        cy = (y0 + y1) / 2
        band_m = (y1 - y0) / pxm_y
        if kind == "roof":  # roundel + sponsor text on the roof
            r_m = min(0.15, band_m * 0.28, width * 0.30)
            if len(sponsors) > 1 and band_m > 0.55:
                wtext((WRAP_W / 2, cy - (r_m + 0.10) * pxm_y), sponsors[1], 0.085, accent)
                cy += 0.05 * pxm_y
            roundel(WRAP_W / 2, cy, r_m)
            wtext((WRAP_W / 2, cy), num, r_m * 1.25, (18, 18, 22))
        elif kind == "windshield" and band_m > 0.22:
            # team banner across the top of the glass (reads from the nose)
            d.rectangle([0, y1 - 0.085 * pxm_y, WRAP_W, y1 - 0.02 * pxm_y], fill=(245, 245, 242))
            wtext((WRAP_W / 2, y1 - 0.052 * pxm_y), team, 0.045, accent, rot180=True)
        elif kind == "hood" and band_m > 0.22:
            wtext((WRAP_W / 2, y0 + (y1 - y0) * 0.22), team, 0.06, accent, rot180=True)
            r_m = min(0.13, band_m * 0.24, width * 0.26)
            hy = y0 + (y1 - y0) * 0.62
            roundel(WRAP_W / 2, hy, r_m)
            wtext((WRAP_W / 2, hy), num, r_m * 1.25, (18, 18, 22), rot180=True)  # reads from the nose, like the hood text
        elif kind == "nose" and y1 - y0 > 24:
            # headlights + grille on the fascia band only — the closing band
            # at the image bottom is the under-nose: plain bumper
            d.rectangle([0, y0, WRAP_W, y1], fill=body)
            d.rectangle([0, y1 - (y1 - y0) * 0.28, WRAP_W, y1], fill=stripe)
            if y1 < WRAP_H - 2:
                for cx in (WRAP_W * 0.18, WRAP_W * 0.82):
                    d.rectangle([cx - 55, cy - 14, cx + 55, cy + 10], fill=(238, 234, 205))
                d.rectangle([WRAP_W * 0.38, cy - 12, WRAP_W * 0.62, cy + 10], fill=(20, 22, 26))
        elif kind == "tail" and y1 - y0 > 24:
            d.rectangle([0, y0, WRAP_W, y1], fill=body)
            d.rectangle([0, y1 - (y1 - y0) * 0.22, WRAP_W, y1], fill=(25, 28, 34))
            for cx in (WRAP_W * 0.2, WRAP_W * 0.8):
                d.rectangle([cx - 70, cy - 11, cx + 70, cy + 11], fill=(190, 30, 35))
            wtext((WRAP_W / 2, cy), lv.get("badge", "PGP"), 0.06, accent)
            wtext((WRAP_W * 0.3, cy), num, 0.07, (20, 20, 24))

    return grain(img, seed=5)


def main():
    kit_path = Path(sys.argv[1])
    kit = json.loads(kit_path.read_text())
    lv = kit.get("livery")
    if lv is None:
        sys.exit("kit has no livery block — nothing to paint")
    out = ROOT / "work" / "cars" / f"{kit['id']}.textures"
    out.mkdir(parents=True, exist_ok=True)
    paint_side(kit, lv, mirrored=False).save(out / "side_right.png")
    paint_side(kit, lv, mirrored=True).save(out / "side_left.png")
    paint_wrap(kit, lv).save(out / "wrap.png")
    print(out)


if __name__ == "__main__":
    main()
