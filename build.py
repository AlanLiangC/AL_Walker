"""Package the standard city and the scanned alley as offline HTML entry points."""
from base64 import b64encode
from pathlib import Path
import json
import mimetypes
import re
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parent
IMPORT = re.compile(r"""((?:from\s+|import\()['"])\./([\w-]+)\.mjs(['"])""")
SOURCE_IMPORT = '<script type="importmap">{"imports":{"playcanvas":"../assets/scan/playcanvas.min.mjs"}}</script>'
SOG_MAPS = ("means", "scales", "quats", "sh0", "shN")


def data_url(path, media_type=None, contents=None):
    content = path.read_bytes() if contents is None else contents
    media_type = media_type or mimetypes.guess_type(path.name)[0]
    return f"data:{media_type};base64,{b64encode(content).decode()}"


def write_entry(name, html):
    for path in (name, f"dist/{name}"):
        output = ROOT / path
        output.parent.mkdir(exist_ok=True)
        output.write_text(html, encoding="utf-8")
        print(f"{path} ({output.stat().st_size:,} bytes)")


def pack_tile(path):
    with ZipFile(path) as archive:
        meta = json.loads(archive.read("meta.json"))
        required = {name for kind in SOG_MAPS for name in meta.get(kind, {}).get("files", [])}
        missing = required.difference(archive.namelist())
        if missing:
            raise ValueError(f"{path.name} is missing {', '.join(sorted(missing))}")
    return data_url(path, "application/zip")


def bundle():
    modules = {}
    for source in sorted((ROOT / "src").glob("*.mjs")):
        code = IMPORT.sub(r"\1@citynav/\2\3", source.read_text(encoding="utf-8"))
        modules[f"@citynav/{source.stem}"] = data_url(source, "text/javascript", code.encode())
    html = (ROOT / "src" / "index.html").read_text(encoding="utf-8")
    css = (ROOT / "style.css").read_text(encoding="utf-8")
    html = html.replace(SOURCE_IMPORT, "").replace('<body data-source>', '<body>')
    html = html.replace('<link rel="stylesheet" href="../style.css">', f"<style>\n{css}</style>")
    html = html.replace('import("./app.mjs")', 'import("@citynav/app")')

    def linked_html(page, imports):
        return page.replace(
            "<!-- MODULE_IMPORT_MAP -->",
            '<script type="importmap">' + json.dumps({"imports": imports}) + '</script>',
        )

    def embed(page, marker, element_id, assets):
        return page.replace(
            marker,
            f'<script type="application/json" id="{element_id}">' + json.dumps(assets) + '</script>',
        )

    textures = {
        name: data_url(ROOT / "assets" / name)
        for name in ("surfaces.webp", "surface-relief.webp", "leaves.webp", "sky.jpg")
    }
    city = embed(html, "<!-- CITY_TEXTURES -->", "city-textures", textures)
    write_entry("index.html", linked_html(city, modules))

    scan_dir = ROOT / "assets" / "scan"
    tile_files = [scan_dir / f"artillery-{index}.sog" for index in range(5)]
    tiles = {file.name: pack_tile(file) for file in tile_files}
    scan_modules = {**modules, "playcanvas": data_url(scan_dir / "playcanvas.min.mjs", "text/javascript")}
    scan = embed(html, "<!-- SCAN_SOGS -->", "scan-sogs", tiles)
    scan = scan.replace('<body>', '<body data-world="scan">')
    # Keep required notices with the standalone HTML when it is copied.
    attribution = (scan_dir / "NOTICE.txt").read_text(encoding="utf-8")
    license_text = (scan_dir / "LICENSE-playcanvas.txt").read_text(encoding="utf-8")
    scan = scan.replace("</html>", f"<!-- Attribution and license\n{attribution}\n{license_text}\n-->\n</html>")
    write_entry("artillery.html", linked_html(scan, scan_modules))


if __name__ == "__main__":
    bundle()
