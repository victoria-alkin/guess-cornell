#!/usr/bin/env python3
"""Build data/locations.json and web-ready panoramas from the locations spreadsheet.

    python scripts/build_locations.py
    python scripts/build_locations.py --xlsx "assets/Photos and Infos.xlsx" --max-width 6000

Spreadsheet columns (header row, any order, case-insensitive):
    Photo            filename of the 360° JPG in assets/photos/ (e.g. "Courtyard.jpg").
                     If empty, a photo embedded in that row of the spreadsheet is used.
    Title            location name, shown after guessing
    Pin              "42.4490, -76.4889"  or  42°26'55.8"N 76°29'20.0"W
    Fun Fact         optional; a leading "Fun Fact:" is removed
    Start Direction  optional; initial view direction in degrees (0 = photo center)

Output:
    panos/<hash>.jpg      resized photos with names that don't reveal the location
    data/locations.json   what the game loads
"""
import argparse
import hashlib
import io
import json
import posixpath
import re
import sys
import zipfile
from pathlib import Path

try:
    import olefile
    import openpyxl
    from PIL import Image
except ImportError:
    sys.exit("Missing packages. Run:  python -m pip install -r scripts/requirements.txt")

Image.MAX_IMAGE_PIXELS = None  # panoramas are legitimately huge

ROOT = Path(__file__).resolve().parent.parent

COLUMN_ALIASES = {
    "photo": "photo", "image": "photo", "file": "photo",
    "title": "title", "name": "title",
    "pin": "pin", "location": "pin", "coordinates": "pin",
    "fun fact": "fact", "funfact": "fact", "fact": "fact",
    "start direction": "yaw", "start yaw": "yaw", "startyaw": "yaw", "direction": "yaw",
}


# ---------- Pins ----------

def parse_pin(value):
    """Return (lat, lng) from decimal or degrees-minutes-seconds text, else None."""
    if value is None:
        return None
    s = str(value).strip()

    m = re.fullmatch(r"\(?\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*\)?", s)
    if m:
        return float(m[1]), float(m[2])

    parts = re.findall(
        r"(\d+(?:\.\d+)?)\s*[°º˚]\s*"
        r"(?:(\d+(?:\.\d+)?)\s*['′’]\s*)?"
        r"(?:(\d+(?:\.\d+)?)\s*(?:\"|″|”|''|’’)\s*)?"
        r"([NSEW])",
        s, re.IGNORECASE,
    )
    coords = {}
    for deg, minutes, seconds, hemi in parts:
        v = float(deg) + float(minutes or 0) / 60 + float(seconds or 0) / 3600
        hemi = hemi.upper()
        if hemi in "SW":
            v = -v
        coords["lat" if hemi in "NS" else "lng"] = v
    if "lat" in coords and "lng" in coords:
        return coords["lat"], coords["lng"]
    return None


# ---------- Photos embedded in the spreadsheet ----------

def unpack_ole_package(blob):
    """Extract (filename, bytes) from an Excel 'Packager Shell Object' attachment."""
    try:
        ole = olefile.OleFileIO(io.BytesIO(blob))
        raw = ole.openstream("\x01Ole10Native").read()
        # total size(4) type(2) label\0 source-path\0 reserved(4) temp-path-len(4) temp-path data-len(4) data
        p = 6
        end = raw.index(b"\0", p); label = raw[p:end].decode("latin-1"); p = end + 1
        end = raw.index(b"\0", p); p = end + 1
        p += 4
        n = int.from_bytes(raw[p:p + 4], "little"); p += 4 + n
        n = int.from_bytes(raw[p:p + 4], "little"); p += 4
        return label, raw[p:p + n]
    except Exception:
        # Fallback: grab the JPEG directly.
        start = blob.find(b"\xff\xd8\xff")
        end = blob.rfind(b"\xff\xd9")
        if start < 0 or end < start:
            return None, None
        return "embedded.jpg", blob[start:end + 2]


def embedded_photos(xlsx_path):
    """Map Excel row number -> (filename, bytes) for files attached to the first sheet."""
    out = {}
    with zipfile.ZipFile(xlsx_path) as z:
        names = set(z.namelist())
        sheet_path = "xl/worksheets/sheet1.xml"
        rels_path = "xl/worksheets/_rels/sheet1.xml.rels"
        if sheet_path not in names or rels_path not in names:
            return out
        sheet = z.read(sheet_path).decode("utf-8")
        rels = z.read(rels_path).decode("utf-8")
        targets = {}
        for rel in re.findall(r"<Relationship\b[^>]*>", rels):
            rid = re.search(r'\bId="([^"]+)"', rel)
            target = re.search(r'\bTarget="([^"]+)"', rel)
            if rid and target:
                targets[rid[1]] = target[1]
        # Excel lists each object twice: a full <oleObject ...>...</oleObject> with the
        # cell anchor, and a self-closing fallback <oleObject .../>. Only the full one counts.
        for attrs, body in re.findall(r"<oleObject\b([^>]*?)(?<!/)>(.*?)</oleObject>", sheet, re.S):
            rid = re.search(r'r:id="([^"]+)"', attrs)
            row = re.search(r"<xdr:row>(\d+)</xdr:row>", body)
            if not rid or not row or rid[1] not in targets:
                continue
            rid = rid[1]
            target = posixpath.normpath(posixpath.join("xl/worksheets", targets[rid]))
            if target not in names:
                continue
            name, data = unpack_ole_package(z.read(target))
            if data:
                out[int(row[1]) + 1] = (name, data)  # anchor rows are 0-based
    return out


# ---------- Image processing ----------

def make_web_jpeg(data, max_width, quality):
    im = Image.open(io.BytesIO(data))
    w, h = im.size
    if abs(w / h - 2) > 0.05:
        print(f"    warning: {w}x{h} is not 2:1; it may not be a full 360° panorama")
    im = im.convert("RGB")
    if w > max_width:
        im = im.resize((max_width, round(h * max_width / w)), Image.LANCZOS)
    buf = io.BytesIO()
    # No EXIF/XMP is copied over, so camera and GPS metadata are stripped.
    im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue(), im.size


def find_photo_file(photos_dir, name):
    name = str(name).strip()
    candidates = [name] if Path(name).suffix else [name + ext for ext in (".jpg", ".jpeg", ".JPG", ".JPEG")]
    for c in candidates:
        p = photos_dir / c
        if p.is_file():
            return p
    lower = {p.name.lower(): p for p in photos_dir.glob("*")} if photos_dir.is_dir() else {}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    return None


# ---------- Main ----------

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--xlsx", default=str(ROOT / "assets" / "Photos and Infos.xlsx"))
    ap.add_argument("--photos", default=str(ROOT / "assets" / "photos"), help="folder with the original 360° JPGs")
    ap.add_argument("--out-images", default=str(ROOT / "panos"))
    ap.add_argument("--out-json", default=str(ROOT / "data" / "locations.json"))
    ap.add_argument("--max-width", type=int, default=6000)
    ap.add_argument("--quality", type=int, default=82)
    args = ap.parse_args()

    xlsx = Path(args.xlsx)
    if not xlsx.is_file():
        sys.exit(f"Spreadsheet not found: {xlsx}")
    photos_dir = Path(args.photos)
    out_images = Path(args.out_images)
    out_images.mkdir(parents=True, exist_ok=True)

    ws = openpyxl.load_workbook(xlsx, data_only=True).worksheets[0]
    header = [str(c.value or "").strip().lower() for c in ws[1]]
    cols = {COLUMN_ALIASES[h]: i for i, h in enumerate(header) if h in COLUMN_ALIASES}
    for required in ("title", "pin"):
        if required not in cols:
            sys.exit(f"Spreadsheet needs a '{required.title()}' column. Found: {header}")

    embedded = embedded_photos(xlsx)
    locations, problems = [], []

    for row_num, row in enumerate(ws.iter_rows(min_row=2, values_only=True), start=2):
        get = lambda key: row[cols[key]] if key in cols and cols[key] < len(row) else None
        title = (str(get("title") or "")).strip()
        pin_text, photo_name = get("pin"), get("photo")
        if not title and not pin_text and not photo_name:
            continue  # blank row
        label = f"Row {row_num} ({title or 'untitled'})"
        print(label)

        pin = parse_pin(pin_text)
        if not pin:
            problems.append(f"{label}: can't read pin {pin_text!r}")
            continue

        if photo_name:
            path = find_photo_file(photos_dir, photo_name)
            if not path:
                problems.append(f"{label}: photo {photo_name!r} not found in {photos_dir}")
                continue
            source = path.read_bytes()
            print(f"    photo: {path.name}")
        elif row_num in embedded:
            name, source = embedded[row_num]
            print(f"    photo: embedded in spreadsheet ({name})")
        else:
            problems.append(f"{label}: no photo (fill in the Photo column)")
            continue

        # Name = hash of the original photo + processing settings: stable across
        # runs, changes if the photo changes, and reveals nothing about the place.
        digest = hashlib.sha256(source + f"|{args.max_width}|{args.quality}".encode()).hexdigest()[:16]
        filename = f"{digest}.jpg"
        out_path = out_images / filename
        if out_path.exists():
            print(f"    -> {filename} (already built)")
        else:
            data, size = make_web_jpeg(source, args.max_width, args.quality)
            out_path.write_bytes(data)
            print(f"    -> {filename}  {size[0]}x{size[1]}, {len(data) / 1e6:.1f} MB")

        entry = {"id": digest, "name": title, "lat": round(pin[0], 7), "lng": round(pin[1], 7), "image": filename}
        fact = str(get("fact") or "").strip()
        fact = re.sub(r"^\s*fun\s*fact\s*[:\-–]\s*", "", fact, flags=re.IGNORECASE)
        if fact:
            entry["funFact"] = fact
        yaw = get("yaw")
        if yaw not in (None, ""):
            try:
                entry["startYaw"] = float(yaw)
            except ValueError:
                problems.append(f"{label}: start direction {yaw!r} is not a number (ignored)")
        locations.append(entry)

    Path(args.out_json).write_text(json.dumps(locations, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nWrote {len(locations)} locations to {args.out_json}")

    used = {loc["image"] for loc in locations}
    stale = [p.name for p in out_images.glob("*.jpg") if p.name not in used]
    if stale:
        print(f"Note: {len(stale)} photo(s) in {out_images} are no longer used: {', '.join(stale)}")
    if problems:
        print("\nProblems:")
        for p in problems:
            print("  - " + p)
        sys.exit(1)


if __name__ == "__main__":
    main()
