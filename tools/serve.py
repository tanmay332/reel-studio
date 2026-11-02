"""Serve editing-studio over HTTP with range requests, so videos seek properly.

Usage:
    python tools/serve.py [port]      (default 8765)

python -m http.server ignores Range headers, which breaks <video> seeking and looping.

Studio API:
    GET  /api/styles   every saved style in styles/*.json
    POST /api/save     {name, picks, clip, overwrite?} -> styles/<name>.json (409 if it exists and no overwrite)
    POST /api/render   {picks, name} -> runs tools/render_studio.cjs, a draft in projects/<clip>/renders/
    GET  /api/render/status
    POST /api/approve  {file} -> copies an approved draft to VideoEditor/output (never overwrites)
    POST /api/reveal   {file} -> shows a render in File Explorer
    GET  /api/clips    every clip the Studio can open (studio/data and projects/*/studio)

Add video (tools/import_clip.py does the work):
    PUT  /api/upload?name=<file name>   raw file body -> clips/<name>
    POST /api/import       {source (path or link), name} -> transcribes and splits into phrases
    GET  /api/import/status?project=projects/<name>  progress, then the phrases to pick from
    POST /api/import/cut   {project, phrases} -> cuts the kept phrases and makes the Studio files

Render jobs carry "data": the clip's folder relative to studio/ ("data" or "../projects/<name>/studio").
"""

import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

STUDIO = Path(__file__).resolve().parent.parent
DATA = STUDIO / "studio" / "data"
FINAL_DIR = Path.home() / "VideoEditor" / "output"
RENDER = {"proc": None}
IMPORT = {"proc": None, "project": None}
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".zip"}


def slugify(name):
    return re.sub(r"[^a-z0-9]+", "-", str(name or "").lower()).strip("-")


class RangeHandler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".mp4": "video/mp4", ".json": "application/json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        route = self.path.split("?")[0]
        if route == "/":
            self.send_response(302)
            self.send_header("Location", "/studio/")
            self.end_headers()
            return
        if route == "/api/render/status":
            return self.send_json(self.render_status())
        if route == "/api/clips":
            return self.send_json(self.clips())
        if route == "/api/import/status":
            return self.send_json(self.import_status(self.query().get("project", "")))
        if route == "/api/styles":
            styles = []
            for f in sorted((STUDIO / "styles").glob("*.json")):
                try:
                    styles.append({**json.loads(f.read_text(encoding="utf-8")), "file": f"styles/{f.name}"})
                except (ValueError, OSError):
                    pass
            return self.send_json(styles)
        return super().do_GET()

    def query(self):
        return {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}

    def data_dir(self, data):
        """A clip's Studio folder, given relative to studio/ ("data" or "../projects/<name>/studio")."""
        d = (STUDIO / "studio" / (data or "data")).resolve()
        if STUDIO not in d.parents or not (d / "clip.json").is_file():
            raise ValueError(f"No clip in {data}")
        return d

    def clips(self):
        out = []
        for d in [DATA, *(STUDIO / "projects").glob("*/studio")]:
            try:
                c = json.loads((d / "clip.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                continue
            out.append({"data": Path(os.path.relpath(d, STUDIO / "studio")).as_posix(), "name": c.get("name"),
                        "duration": c.get("duration"), "modified": (d / "clip.json").stat().st_mtime})
        return sorted(out, key=lambda c: -c["modified"])

    def project_dir(self, project):
        d = (STUDIO / str(project or "")).resolve()
        if (STUDIO / "projects") not in d.parents:
            raise ValueError("Not a project folder")
        return d

    def import_status(self, project):
        try:
            d = self.project_dir(project)
            status = json.loads((d / "import-progress.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"state": "idle"}
        proc = IMPORT["proc"]
        if status.get("state") == "running":
            if IMPORT["project"] != project:
                status.update(state="error", msg="This import was interrupted (the Studio server restarted). Start it again.")
            elif proc is None or proc.poll() is not None:
                log = (d / "import.log").read_text(encoding="utf-8", errors="replace") if (d / "import.log").exists() else ""
                status.update(state="error", msg="The import stopped before finishing.\n" + "\n".join(log.splitlines()[-4:]))
        if status.get("state") == "ready":
            try:
                status["import"] = json.loads((d / "import.json").read_text(encoding="utf-8"))
            except (OSError, ValueError):
                pass
        return status

    def run_import(self, project, args):
        if IMPORT["proc"] and IMPORT["proc"].poll() is None:
            return self.send_json({"error": "Another video is still being prepared. Wait for it to finish."}, 409)
        d = STUDIO / project
        d.mkdir(parents=True, exist_ok=True)
        (d / "import-progress.json").write_text(json.dumps(
            {"state": "running", "stage": "start", "msg": "Starting", "project": project}), encoding="utf-8")
        log = open(d / "import.log", "w", encoding="utf-8")
        IMPORT.update(project=project, proc=subprocess.Popen(
            [sys.executable, str(STUDIO / "tools" / "import_clip.py"), *args], cwd=STUDIO, stdout=log, stderr=subprocess.STDOUT))
        return self.send_json({"ok": True, "project": project})

    def start_import(self, body):
        source, name = str(body.get("source", "")).strip().strip('"'), str(body.get("name", "")).strip()
        if not source:
            return self.send_json({"error": "Choose a video, or paste its path or link."}, 400)
        name = name or Path(source.split("?")[0].rstrip("/\\")).stem or "clip"
        base = slugify(name)[:48] or "clip"
        slug, n = base, 2
        while (STUDIO / "projects" / slug).exists():
            slug, n = f"{base}-{n}", n + 1
        return self.run_import(f"projects/{slug}", ["fetch", source, "--name", name])

    def import_cut(self, body):
        try:
            d = self.project_dir(body.get("project"))
            info = json.loads((d / "import.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            return self.send_json({"error": str(e)}, 400)
        picked = {int(p["id"]): p for p in body.get("phrases", [])}
        for p in info["phrases"]:
            if p["id"] in picked:
                p["keep"] = bool(picked[p["id"]].get("keep"))
                p["text"] = str(picked[p["id"]].get("text", p["text"])).strip()
        (d / "import.json").write_text(json.dumps(info, indent=1, ensure_ascii=False), encoding="utf-8")
        return self.run_import(body["project"], ["build", body["project"]])

    def upload(self):
        name = Path(self.query().get("name", "video.mp4")).name
        stem, ext = slugify(Path(name).stem) or "clip", Path(name).suffix.lower()
        if ext not in VIDEO_EXT:
            return self.send_json({"error": f"{name} isn't a video file."}, 400)
        dest, n = STUDIO / "clips" / f"{stem}{ext}", 2
        while dest.exists():
            dest, n = dest.with_name(f"{stem}-{n}{ext}"), n + 1
        dest.parent.mkdir(exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        left = int(self.headers.get("Content-Length", 0))
        try:
            with open(part, "wb") as f:
                while left > 0:
                    chunk = self.rfile.read(min(1024 * 1024, left))
                    if not chunk:
                        break
                    f.write(chunk)
                    left -= len(chunk)
        except OSError:
            left = left or 1
        if left:
            part.unlink(missing_ok=True)
            return self.send_json({"error": "The upload stopped part way. Try again."}, 400)
        part.rename(dest)
        return self.send_json({"ok": True, "path": dest.relative_to(STUDIO).as_posix()})

    def reveal(self, body):
        f = Path(str(body.get("file", "")))
        f = f if f.is_absolute() else (STUDIO / f).resolve()
        if not f.is_file() or f.suffix != ".mp4":
            return self.send_json({"error": "That file isn't there any more."}, 404)
        subprocess.Popen(["explorer", "/select,", str(f)])
        return self.send_json({"ok": True})

    def render_status(self):
        try:
            status = json.loads((DATA / "render-progress.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"state": "idle"}
        try:
            status["picks"] = json.loads((DATA / "render-job.json").read_text(encoding="utf-8")).get("picks")
        except (OSError, ValueError):
            pass
        proc = RENDER["proc"]
        if status.get("state") == "running" and proc is None:
            status.update(state="error", error="The last render was interrupted (the Studio server restarted). Press Render to start again.")
        elif status.get("state") == "running" and proc.poll() is not None:
            log_file = DATA / "render.log"
            log = log_file.read_text(encoding="utf-8", errors="replace") if log_file.exists() else ""
            status.update(state="error", error="The render stopped before finishing.\n" + "\n".join(log.splitlines()[-8:]))
        return status

    def start_render(self, body):
        if RENDER["proc"] and RENDER["proc"].poll() is None:
            return self.send_json({"error": "A render is already running."}, 409)
        try:
            data = self.data_dir(body.get("data"))
        except ValueError as e:
            return self.send_json({"error": str(e)}, 400)
        clip = json.loads((data / "clip.json").read_text(encoding="utf-8"))
        renders = STUDIO / Path(clip["source"]).parent
        base = f"{renders.parent.name}-{slugify(body.get('name')) or 'edit'}"
        n = 1
        while (renders / f"{base}-v{n}.mp4").exists():
            n += 1
        out = renders / f"{base}-v{n}.mp4"
        rel = out.relative_to(STUDIO).as_posix()
        job = DATA / "render-job.json"
        job.write_text(json.dumps({"picks": body.get("picks", {}), "name": body.get("name"),
                                   "data": body.get("data") or "data"}, indent=2), encoding="utf-8")
        (DATA / "render-progress.json").write_text(json.dumps({"state": "running", "stage": "starting", "out": rel}), encoding="utf-8")
        log = open(DATA / "render.log", "w", encoding="utf-8")
        RENDER["proc"] = subprocess.Popen(
            [shutil.which("node") or "node", str(STUDIO / "tools" / "render_studio.cjs"), str(job), str(out),
             str(self.server.server_address[1])],
            cwd=STUDIO, stdout=log, stderr=subprocess.STDOUT)
        return self.send_json({"ok": True, "out": rel})

    def approve(self, body):
        src = (STUDIO / str(body.get("file", ""))).resolve()
        if src.suffix != ".mp4" or not src.is_file() or (STUDIO / "projects") not in src.parents:
            return self.send_json({"error": "That isn't a render in projects/."}, 400)
        dest = FINAL_DIR / src.name
        if dest.exists():
            return self.send_json({"error": "exists", "file": str(dest)}, 409)
        FINAL_DIR.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        return self.send_json({"ok": True, "file": str(dest)})

    def do_PUT(self):
        if self.path.split("?")[0] == "/api/upload":
            return self.upload()
        return self.send_error(404)

    def do_POST(self):
        route = self.path.split("?")[0]
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except ValueError:
            return self.send_json({"error": "Bad JSON"}, 400)
        if route == "/api/render":
            return self.start_render(body)
        if route == "/api/approve":
            return self.approve(body)
        if route == "/api/reveal":
            return self.reveal(body)
        if route == "/api/import":
            return self.start_import(body)
        if route == "/api/import/cut":
            return self.import_cut(body)
        if route != "/api/save":
            return self.send_error(404)
        name = str(body.get("name", "")).strip()
        slug = slugify(name)
        if not slug:
            return self.send_json({"error": "Give the style a name."}, 400)
        path = STUDIO / "styles" / f"{slug}.json"
        if path.exists() and not body.get("overwrite"):
            return self.send_json({"error": "exists", "file": f"styles/{slug}.json"}, 409)
        path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps({
            "name": name,
            "savedAt": datetime.now().isoformat(timespec="seconds"),
            "clip": body.get("clip"),
            "picks": body.get("picks", {}),
        }, indent=2), encoding="utf-8")
        return self.send_json({"ok": True, "file": f"styles/{slug}.json"})

    def send_head(self):
        self._remaining = None
        path = self.translate_path(self.path)
        match = re.match(r"bytes=(\d*)-(\d*)$", self.headers.get("Range", ""))
        if not match or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        start = int(match[1]) if match[1] else max(0, size - int(match[2] or 0))
        end = min(int(match[2]), size - 1) if match[1] and match[2] else size - 1
        if start >= size:
            self.send_error(416, "Range not satisfiable")
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        try:
            while remaining > 0:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (ConnectionResetError, BrokenPipeError):
            pass  # the browser drops range requests mid-stream whenever it seeks

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    server = ThreadingHTTPServer(("127.0.0.1", port), partial(RangeHandler, directory=str(STUDIO)))
    print(f"Serving {STUDIO} at http://localhost:{port}")
    server.serve_forever()
