"""CityNav and its optional local EdenLive WebRTC service."""
import argparse
import asyncio
import hmac
import json
import logging
import os
from pathlib import Path
import re
import ssl
import uuid

from aiohttp import web
from aiortc import RTCSessionDescription
from PIL import Image
import numpy as np

from .appearance import Appearance
from .photo import PhotoRenderer
from .session import Session, log
from .worker import GpuWorker, PassthroughWorker, reset

REPO = Path(__file__).resolve().parents[2]
PROFILES = Path(__file__).resolve().with_name("profiles")
EPISODE = re.compile(r"[a-z0-9-]{1,60}")


def load_profile(name):
    path = PROFILES / (name + ".json")
    profile = json.loads(path.read_text())
    width, height, fps = (profile[k] for k in ("width", "height", "fps"))
    if width < 320 or width > 1280 or height > 704 or height < 160 or not 1 <= fps <= 30:
        raise ValueError("Invalid media geometry")
    if width % 32 or height % 32:
        raise ValueError("Both dimensions must be divisible by 32")
    return profile


class Service:
    def __init__(self, args):
        self.args = args
        self.profile = load_profile(args.profile)
        self.appearance = Appearance.load(args.style)
        self.token = os.getenv("CITYNAV_EDEN_TOKEN")
        self.ice_servers = json.loads(os.getenv("CITYNAV_ICE_SERVERS", "[]"))
        self.sessions = {}
        self.tasks = set()
        self.shutting_down = False
        if self.profile["backend"] == "edenlive":
            if not args.source or not args.weights or not args.gpu:
                raise ValueError("EdenLive requires --source, --weights and at least one --gpu")
            if len(set(args.gpu)) != len(args.gpu):
                raise ValueError("GPU UUIDs must be distinct")
            self.workers = [GpuWorker(gpu, self.profile, args.source, args.weights) for gpu in args.gpu]
        else:
            self.workers = [PassthroughWorker(i) for i in range(args.capacity)]

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)

    async def start(self, app):
        for worker in self.workers:
            if isinstance(worker, GpuWorker):
                self.spawn(self.warm(worker))

    async def warm(self, worker):
        try:
            info = await worker.start()
            log("worker-ready", gpu=worker.gpu, **info)
        except Exception:
            logging.getLogger("citynav.eden").exception("Warmup failed on %s", worker.gpu)

    async def release(self, session, broken):
        worker = session.worker
        if not self.shutting_down and isinstance(worker, GpuWorker):
            try:
                if not broken:
                    await worker.run(reset)
            except Exception:
                broken = True
            if broken:
                worker.shutdown()
                self.spawn(self.warm(worker))
        self.sessions.pop(session.key, None)
        worker.in_use = False

    async def cleanup(self, app):
        self.shutting_down = True
        await asyncio.gather(*(s.close("service-shutdown") for s in list(self.sessions.values())))
        for task in self.tasks.copy():
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        for worker in self.workers:
            if isinstance(worker, GpuWorker):
                worker.shutdown()

    @web.middleware
    async def guard(self, req, handler):
        if not req.path.startswith("/eden/"):
            return await handler(req)
        origin = req.headers.get("Origin")
        # Browsers may omit Origin on same-origin GETs.
        local_origins = {f"{s}://{req.host}" for s in ("http", "https")}
        if origin and origin not in local_origins and origin not in self.args.allow_origin:
            return web.json_response({"error": "origin"}, status=403)
        headers = {
            "Cache-Control": "no-store", "Vary": "Origin",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Authorization, Content-Type",
            "Access-Control-Expose-Headers": "X-CityNav-Frame, X-CityNav-Tick, X-CityNav-Render-Ms",
        }
        if origin:
            headers["Access-Control-Allow-Origin"] = origin
        if req.method == "OPTIONS":
            return web.Response(status=204, headers=headers)
        if self.token and not hmac.compare_digest(req.headers.get("Authorization", ""), "Bearer " + self.token):
            return web.json_response({"error": "authorization"}, status=401, headers=headers)
        try:
            response = await handler(req)
        except web.HTTPException as error:
            return web.json_response({"error": error.reason}, status=error.status, headers=headers)
        response.headers.update(headers)
        return response

    async def config(self, req):
        keys = ("backend", "width", "height", "fps", "warmMs", "stallMs", "maxAgeMs", "tier")
        return web.json_response({key: self.profile[key] for key in keys} | {"photo": self.args.photo_scene is not None})

    async def health(self, req):
        return web.json_response({"profile": self.profile, "workers": [
            {"gpu": worker.gpu, "ready": worker.ready, "busy": worker.in_use, "info": worker.info}
            for worker in self.workers]})

    def reference_for(self, context):
        if not self.args.references or context["cameraMode"] == "sensor":
            return None
        name = "{episodeId}-{seed}-{cameraMode}-{weather}.png".format(**context)
        path = self.args.references / name
        manifest = path.with_suffix(".json")
        if path.is_file() and manifest.is_file():
            metadata = json.loads(manifest.read_text())
            width, height = self.profile["width"], self.profile["height"]
            with Image.open(path) as image:
                if (image.width, image.height) != (width, height):
                    raise ValueError(f"Reference {name} must be {width}×{height}")
                return np.array(image.convert("RGB")), metadata["camera"], 0

    async def offer(self, req):
        try:
            data = await req.json()
            key, epoch, context = data["sessionId"], data["epoch"], data["context"]
            if (str(uuid.UUID(key)) != key or type(epoch) is not int or epoch < 1
                    or data["type"] != "offer" or not isinstance(data["sdp"], str)
                    or not EPISODE.fullmatch(context["episodeId"])
                    or context["cameraMode"] not in ("robot", "chase", "sensor")
                    or context.get("robotId") not in (None, "go2", "b2", "g1")
                    or type(context["seed"]) is not int or not 0 <= context["seed"] <= 0xFFFFFFFF
                    or context["weather"] not in ("day", "wet", "rain", "night", "snow", "fog")):
                raise ValueError
        except (KeyError, ValueError, TypeError, AttributeError):
            raise web.HTTPBadRequest(reason="invalid offer")
        context = {name: context.get(name) for name in ("episodeId", "cameraMode", "seed", "weather", "robotId")}
        worker = next((w for w in self.workers if w.ready and not w.in_use), None)
        if worker is None or self.shutting_down:
            raise web.HTTPServiceUnavailable(reason="no available worker")
        if key in self.sessions:
            raise web.HTTPConflict(reason="duplicate session")
        worker.in_use = True
        session = None
        try:
            appearance = self.appearance.for_context(context)
            references = []
            if self.profile["backend"] == "edenlive" and context["cameraMode"] != "sensor":
                references.extend(appearance.references_for(context, self.profile["width"], self.profile["height"]))
                if not references and (reference := self.reference_for(context)) is not None:
                    references.append(reference)
            session = Session(key, epoch, context, worker, self.profile, self.release,
                              references, self.ice_servers, appearance)
            self.sessions[key] = session
            await session.peer.setRemoteDescription(RTCSessionDescription(data["sdp"], "offer"))
            session.peer.addTrack(session.track)
            await asyncio.wait_for(session.peer.setLocalDescription(await session.peer.createAnswer()), timeout=4)
            session.start()
            answer = session.peer.localDescription
            return web.json_response({"type": answer.type, "sdp": answer.sdp})
        except BaseException:
            if session is not None:
                await session.close("offer-error")
            else:
                worker.in_use = False
            raise

    async def close(self, req):
        try:
            key = (await req.json())["sessionId"]
            if str(uuid.UUID(key)) != key:
                raise ValueError
        except (KeyError, TypeError, ValueError, AttributeError):
            raise web.HTTPBadRequest(reason="invalid session ID")
        session = self.sessions.get(key)
        if session is not None:
            self.spawn(session.close("client-close"))
        return web.json_response({"closed": session is not None})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--profile", choices=[p.stem for p in sorted(PROFILES.glob("*.json"))], default="passthrough")
    parser.add_argument("--capacity", type=int, choices=range(1, 5), default=4)
    parser.add_argument("--gpu", action="append", default=[])
    parser.add_argument("--source", type=Path)
    parser.add_argument("--weights", type=Path)
    parser.add_argument("--references", type=Path)
    parser.add_argument("--style", type=Path, help="Appearance JSON with paths relative to that file")
    parser.add_argument("--photo-blender", type=Path)
    parser.add_argument("--photo-scene", type=Path)
    parser.add_argument("--photo-style", type=Path)
    parser.add_argument("--photo-gpu", default="0")
    parser.add_argument("--photo-compute", choices=("OPTIX", "CUDA", "CPU"), default="OPTIX")
    parser.add_argument("--allow-origin", action="append", default=[])
    parser.add_argument("--cert", type=Path)
    parser.add_argument("--key", type=Path)
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    logging.getLogger("aioice").setLevel(logging.WARNING)
    service = Service(args)
    app = web.Application(middlewares=[service.guard], client_max_size=64_000)
    app.on_startup.append(service.start)
    app.on_cleanup.append(service.cleanup)
    app.router.add_get("/", lambda req: web.HTTPFound("/src/?eden=/eden"))
    app.router.add_get("/src/", lambda req: web.FileResponse(REPO / "src/index.html"))
    app.router.add_get("/style.css", lambda req: web.FileResponse(REPO / "style.css"))
    app.router.add_get("/artillery.html", lambda req: web.FileResponse(REPO / "artillery.html"))
    app.router.add_static("/src/", REPO / "src")
    app.router.add_static("/assets/", REPO / "assets")
    app.router.add_get("/eden/config", service.config)
    app.router.add_get("/eden/health", service.health)
    app.router.add_post("/eden/offer", service.offer)
    app.router.add_post("/eden/close", service.close)
    photo_paths = (args.photo_blender, args.photo_scene, args.photo_style)
    if any(photo_paths):
        if not all(path is not None and path.is_file() for path in photo_paths):
            parser.error("Photo requires Blender, a CityNav scene manifest and a style JSON")
        blender, scene, style = (path.resolve() for path in photo_paths)
        photo = PhotoRenderer(blender, REPO / "tools/visual/cycles-worker.py", scene, style, args.photo_gpu,
                              args.photo_compute)
        app.router.add_get("/eden/photo/config", photo.config)
        app.router.add_post("/eden/photo/frame", photo.frame)

        async def stop_photo(_):
            await photo.stop()

        app.on_cleanup.append(stop_photo)
    app.router.add_route("OPTIONS", "/eden/{path}", service.config)
    app.router.add_route("OPTIONS", "/eden/photo/{path}", service.config)
    tls = None
    if args.cert:
        tls = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
        tls.load_cert_chain(args.cert, args.key)
    web.run_app(app, host=args.host, port=args.port, ssl_context=tls, access_log=None)


if __name__ == "__main__":
    main()
