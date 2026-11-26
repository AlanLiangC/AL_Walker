"""Reference-conditioned video sessions driven by CityNav observations."""
import asyncio
import base64
import binascii
from collections import OrderedDict, deque
from dataclasses import dataclass, field
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import re
import signal
import sys
import time
import uuid

from aiohttp import web
import numpy as np
from PIL import Image, UnidentifiedImageError

from .session import correct_signal_color


PROXIES = {(640, 352), (832, 480), (1280, 704), (1344, 768)}
CONTEXT_FIELDS = ("episode", "robot", "seed", "weather", "view")
ALTERNATIVES = ("edge-turbo", "sharp")


def canonical_id(value):
    if str(uuid.UUID(value)) != value:
        raise ValueError("invalid request ID")
    return value


def context_of(value):
    context = {name: value[name] for name in CONTEXT_FIELDS}
    if (not re.fullmatch(r"[a-z0-9-]{1,64}", context["episode"])
            or context["robot"] not in ("go2", "b2", "g1")
            or context["view"] not in ("robot", "chase")
            or context["weather"] not in ("day", "wet", "rain", "snow", "night", "fog")
            or type(context["seed"]) is not int or not 0 <= context["seed"] <= 0xFFFFFFFF):
        raise ValueError("invalid render context")
    return context


async def observation_payload(req):
    try:
        data = await req.clone(client_max_size=6 * 1024 * 1024).json()
        key, tick = canonical_id(data["key"]), data["tick"]
        if type(tick) is not int or tick < 0:
            raise ValueError("invalid CityNav clock")
        image = Image.open(BytesIO(base64.b64decode(data["proxy"], validate=True)))
        if image.format != "PNG" or image.size not in PROXIES:
            raise ValueError("invalid CityNav proxy frame")
        return data, key, tick, context_of(data["context"]), image.convert("RGB")
    except (KeyError, ValueError, TypeError, AttributeError, binascii.Error, OSError, UnidentifiedImageError):
        raise web.HTTPBadRequest(reason="invalid CityNav render observation")


def save_control(data, key, path, size, mode):
    try:
        with Image.open(BytesIO(base64.b64decode(data[key], validate=True))) as image:
            if image.format != "PNG" or image.size != size:
                raise ValueError("invalid control dimensions")
            image.convert(mode).save(path, compress_level=1)
    except (KeyError, OSError, TypeError, ValueError, binascii.Error) as error:
        raise web.HTTPBadRequest(reason=f"invalid CityNav {key} observation") from error


def alternative_controls(method, data, directory, size):
    labels = directory / "labels.png"
    save_control(data, "labels", labels, size, "L")
    if method != "sharp":
        return {"labels": str(labels)}
    try:
        calibration = data["calibration"]
        intrinsics = np.asarray(calibration["intrinsics"], dtype=float)
        transform = np.asarray(calibration["worldToCamera"], dtype=float)
        if (intrinsics.shape != (3, 3) or transform.shape != (4, 4)
                or not np.isfinite(intrinsics).all() or not np.isfinite(transform).all()
                or intrinsics[0, 0] <= 0 or intrinsics[1, 1] <= 0
                or not np.allclose(transform[3], [0, 0, 0, 1])
                or not np.allclose(transform[:3, :3] @ transform[:3, :3].T, np.eye(3))):
            raise ValueError("invalid camera matrices")
    except (KeyError, ValueError, TypeError) as error:
        raise web.HTTPBadRequest(reason="invalid CityNav camera calibration") from error
    return {"labels": str(labels), "calibration": calibration,
            "anchorCalibration": str(directory / "anchor-camera.json"),
            "sceneReference": str(directory / "scene-reference.png")}


def correct_rendered_signals(path, source, regions):
    with Image.open(path) as color:
        pixels = np.asarray(color.convert("RGB"))
        aligned = np.asarray(source.resize(color.size, Image.Resampling.LANCZOS))
        corrected, amount = correct_signal_color(pixels, aligned, regions)
    if amount:
        Image.fromarray(corrected).save(path)


class WorldProcess:
    def __init__(self, command, env, timeout):
        self.command, self.env, self.timeout = command, env, timeout
        self.process = None
        self.lock = asyncio.Lock()
        self.log = deque(maxlen=15)

    async def reply(self):
        while line := await self.process.stdout.readline():
            if line.startswith(b"CITYNAV "):
                return json.loads(line[8:])
            self.log.append(line.decode(errors="replace").strip())
        raise RuntimeError("reference worker exited: " + " ".join(self.log))

    async def stop(self):
        if self.process is not None:
            if self.process.returncode is None:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            await self.process.wait()
            self.process = None

    async def run(self, job):
        async with self.lock:
            try:
                async with asyncio.timeout(self.timeout):
                    if self.process is None:
                        self.log.clear()
                        self.process = await asyncio.create_subprocess_exec(
                            *self.command, env=self.env, stdin=asyncio.subprocess.PIPE,
                            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT,
                            limit=512_000, start_new_session=True,
                        )
                        if not (await self.reply()).get("ready"):
                            raise RuntimeError("reference worker did not initialize")
                    self.process.stdin.write((json.dumps(job) + "\n").encode())
                    await self.process.stdin.drain()
                    result = await self.reply()
                    if result.get("id") != job["id"] or "error" in result:
                        raise RuntimeError(result.get("error", "reference worker returned the wrong frame"))
                    return result["ms"]
            except (OSError, RuntimeError, TimeoutError, asyncio.CancelledError):
                await self.stop()
                raise


@dataclass
class WorldSession:
    id: str
    context: dict
    method: str
    style: str
    seed: int
    directory: Path
    tick: int
    digest: str
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def frame(self, key, ms, reference=False):
        path = self.directory / ("reference.png" if reference else "frame.png")
        return web.Response(body=path.read_bytes(), content_type="image/png", headers={
            "X-CityNav-Frame": key, "X-CityNav-Tick": str(self.tick), "X-CityNav-Method": self.method,
            "X-CityNav-Render-Ms": f"{ms:.1f}", "X-CityNav-Session": self.id, "X-CityNav-Reference": self.digest,
        })


class ReferenceWorld:
    def __init__(self, repo, runtime, public, editor_gpu, render_gpu, stream=False, regen=False):
        self.root = runtime / "world"
        self.runs = self.root / "sessions"
        self.runs.mkdir(parents=True, exist_ok=True)
        self.qwen = runtime / "models/visual/qwen-image-21"
        if not self.qwen.is_dir():
            self.qwen = public / "Qwen-Image-2.1"
        self.runtime = runtime
        self.stream = stream
        self.regen = regen
        py = repo / "tools/world/reference-worker.py"
        base = {**os.environ, "HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                "OMNI_SCRATCH": str(runtime / "tmp/omni_pre")}
        editor_env = {**base, "CUDA_VISIBLE_DEVICES": editor_gpu}
        editor_env["PYTHONPATH"] = os.pathsep.join((str(runtime / "visual/python"), base.get("PYTHONPATH", "")))
        self.editor = WorldProcess((sys.executable, "-u", str(py), "editor", str(runtime), str(self.qwen)), editor_env, 360)
        self.renderers = {
            "eden-reference": WorldProcess((sys.executable, "-u", str(py), "eden", str(runtime), str(self.qwen),
                                            "--profile", os.getenv("CITYNAV_REFERENCE_EDEN_PROFILE", "ada-720p-vae")),
                                           {**base, "CUDA_VISIBLE_DEVICES": render_gpu}, 240),
        }
        clip_worker = repo / "tools/world/proxy-clips.py"
        self.renderers["solar"] = WorldProcess(
            (sys.executable, "-u", str(clip_worker), "solar", str(runtime)),
            {**base, "CUDA_VISIBLE_DEVICES": os.getenv("CITYNAV_SOLAR_GPUS", "2,3"),
             "PYTORCH_ALLOC_CONF": os.getenv("PYTORCH_ALLOC_CONF", "expandable_segments:True"),
             "PYTHONPATH": os.pathsep.join((str(self.root / "solar-python"), str(runtime / "visual/python"),
                                          base.get("PYTHONPATH", "")))}, 600,
        )
        self.renderers["invoker"] = WorldProcess(
            (sys.executable, "-u", str(clip_worker), "invoker", str(runtime)), base, 600,
        )
        self.cosmos_model = runtime / "models/Cosmos3-Nano-Sim-Transfer"
        self.cosmos_lock = asyncio.Lock()
        self.cosmos_session = None
        self.renderers["cosmos"] = WorldProcess(
            (sys.executable, "-u", str(repo / "tools/world/cosmos-worker.py"), str(self.cosmos_model)),
            {**base, "CUDA_VISIBLE_DEVICES": os.getenv("CITYNAV_COSMOS_GPU", render_gpu),
             "VLLM_WORKER_MULTIPROC_METHOD": "spawn",
             "VLLM_CACHE_ROOT": str(runtime / "cache/vllm"),
             "CITYNAV_COSMOS_EDEN_SOURCE": str(runtime / "upstream"),
             "CITYNAV_COSMOS_LIGHTTAE": str(runtime / "models/EdenLive/decoder-5b/lighttaew2_2.pth"),
             "PYTHONPATH": os.pathsep.join((str(runtime / "realtime/cosmos-python"),
                                          str(runtime / "realtime/vllm-omni"), base.get("PYTHONPATH", "")))}, 240,
        )
        self.alternatives = alternatives = self.root / "alternatives"
        cuda_home = base.get("CUDA_HOME", "/usr/local/cuda")
        alt_env = {**base, "CUDA_VISIBLE_DEVICES": os.getenv("CITYNAV_ALTERNATIVE_GPU", render_gpu),
                   "CUDA_HOME": cuda_home, "MAX_JOBS": base.get("MAX_JOBS", "8"),
                   "TORCH_EXTENSIONS_DIR": str(runtime / "cache/torch-extensions"),
                   "PATH": os.pathsep.join((str(alternatives / "sharp-python/bin"), cuda_home + "/bin", base["PATH"])),
                   "PYTHONPATH": os.pathsep.join((str(repo), str(runtime / "visual/python"), base.get("PYTHONPATH", ""),
                                                  str(alternatives / "sharp-python"), str(alternatives / "python")))}
        for method in ALTERNATIVES:
            self.renderers[method] = WorldProcess(
                (sys.executable, "-u", str(repo / "tools/world/alternative-worker.py"), method, str(alternatives)),
                alt_env, 360,
            )
        self.sessions = OrderedDict()

    def ready(self, method):
        if method == "projected-photo":
            return True
        if method == "eden-stream":
            return self.stream
        if method == "regen":
            return self.regen
        if method == "edge-turbo":
            base = self.alternatives / "models/edge-turbo/base"
            return all(path.is_file() for path in (
                self.alternatives / "img2img-turbo/src/pix2pix_turbo.py",
                self.alternatives / "models/edge-turbo/edge.pkl",
                self.alternatives / "python/peft/__init__.py", base / "text_encoder/model.fp16.safetensors",
                *(base / subdir / "diffusion_pytorch_model.fp16.safetensors" for subdir in ("unet", "vae")),
            ))
        if method == "sharp":
            return all((self.alternatives / name).is_file() for name in (
                "models/sharp/sharp.pt", "ml-sharp/src/sharp/cli/predict.py", "sharp-python/gsplat/__init__.py",
                "models/regen/flux.pth", "regen-native/generator.py",
            ))
        if method == "cosmos":
            shards = self.cosmos_model / "transformer"
            return all(path.is_file() for path in (
                self.runtime / "realtime/cosmos-ticks-ready.json",
                self.runtime / "realtime/cosmos-python/vllm/__init__.py",
                self.cosmos_model / "vae/diffusion_pytorch_model.safetensors",
                *(shards / f"diffusion_pytorch_model-{index:05d}-of-00006.safetensors" for index in range(1, 7)),
            ))
        if method == "eden-reference":
            return all(path.is_file() for path in (
                self.runtime / "upstream/reactor/edenlive_backend.py",
                self.runtime / "models/EdenLive/dit-5b/diffusion_pytorch_model.safetensors",
            ))
        if method == "solar":
            return all(path.is_file() for path in (
                self.root / "SolarRenderer/scripts/render.py", self.root / "models/h3/ready.json",
                self.root / "models/solar/solarrenderer_causal_control_lora.safetensors",
                self.root / "models/solar/solarrenderer_causal_4step_lora.safetensors",
                self.root / "solar-python/diffusers/__init__.py",
            ))
        if method == "invoker":
            values = [os.getenv("CITYNAV_INVOKER_" + name)
                      for name in ("BUNDLE", "ARTIFACT", "PYTHON", "WS")]
            if all(values):
                bundle, artifact, python, uri = values
                return (self.root / "CodeWorldModel/invoker_render.py").is_file() and all(
                    Path(path).is_file() for path in (Path(bundle) / "native-runtime.json", artifact, python)
                ) and uri.startswith(("ws://", "wss://"))
        return False

    async def config(self, _):
        editor = (self.runtime / "visual/python/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py").is_file() and (
            self.qwen / "model_index.json").is_file()
        methods = [("eden-stream", "EdenLive · 连续写实"), ("cosmos", "Cosmos3 · 深度写实"),
                   ("regen", "REGEN FLUX · 连续写实"), ("edge-turbo", "Pix2Pix-Turbo · 语义写实"),
                   ("sharp", "Apple SHARP · 高斯写实"), ("eden-reference", "EdenLive · 参考帧续渲染"),
                   ("projected-photo", "参考照片 · 实时材质"), ("solar", "SolarRenderer"), ("invoker", "Code World Model 2.0")]
        return web.json_response({"editor": editor, "methods": [
            {"id": method, "label": label, "available": (editor or method in ("cosmos", "regen", "edge-turbo"))
             and self.ready(method)}
            for method, label in methods
        ]})

    def streaming_session(self, name, offer):
        context = {"episode": offer["episodeId"], "robot": offer["robotId"], "seed": offer["seed"],
                   "view": offer["cameraMode"], "weather": offer["weather"]}
        session = self.sessions.get(name) if isinstance(name, str) else None
        if session is None or session.method != "eden-stream" or session.context != context:
            raise web.HTTPConflict(reason="streaming reference does not match CityNav context")
        self.sessions.move_to_end(name)
        return session

    async def cosmos_frame(self, job):
        async with self.cosmos_lock:
            opening = job.get("opening") is True
            if not opening and job["session"] != self.cosmos_session:
                raise web.HTTPConflict(reason="Cosmos3 session expired; generate a new opening reference")
            try:
                ms = await self.renderers["cosmos"].run(job)
            except (OSError, RuntimeError, TimeoutError, asyncio.CancelledError):
                self.cosmos_session = None
                raise
            self.cosmos_session = job["session"]
            return ms

    async def start(self, req):
        data, key, tick, context, image = await observation_payload(req)
        style, method = data.get("style"), data.get("method")
        if not isinstance(style, str) or not 1 <= len(style.strip()) <= 2500 or not isinstance(method, str):
            raise web.HTTPBadRequest(reason="style must contain 1–2500 characters")
        if method == "regen" or not self.ready(method):
            raise web.HTTPServiceUnavailable(reason="selected reference renderer is not ready")
        seed = data.get("styleSeed", context["seed"])
        if type(seed) is not int or not 0 <= seed <= 0xFFFFFFFF:
            raise web.HTTPBadRequest(reason="invalid appearance seed")
        name = str(uuid.uuid4())
        directory = self.runs / name
        directory.mkdir()
        proxy, reference = directory / "proxy.png", directory / "reference.png"
        image.save(proxy)
        (directory / "opening-proxy.png").write_bytes(proxy.read_bytes())
        try:
            if method == "cosmos":
                depth = directory / "depth.png"
                save_control(data, "depth", depth, (256, 144), "L")
                ms = await self.cosmos_frame({"id": key, "session": name, "opening": True,
                                              "tick": tick, "style": style.strip(), "seed": seed,
                                              "depth": str(depth), "output": str(reference)})
                correct_rendered_signals(reference, image, data.get("signalRegions"))
            elif method in ALTERNATIVES:
                control = alternative_controls(method, data, directory, image.size)
                ms = 0
                if method == "sharp":
                    static = directory / "static-proxy.png"
                    save_control(data, "staticProxy", static, image.size, "RGB")
                    Path(control["anchorCalibration"]).write_text(json.dumps(control["calibration"]))
                    ms = await self.editor.run({"id": key, "proxy": str(static), "output": control["sceneReference"],
                                                "seed": seed, "style": style.strip(), "environment": True})
                ms += await self.renderers[method].run({"id": key, "session": name, "proxy": str(proxy),
                                                      "output": str(reference), "style": style.strip(), "seed": seed,
                                                      **control})
                correct_rendered_signals(reference, image, data.get("signalRegions"))
            else:
                ms = await self.editor.run({"id": key, "proxy": str(proxy), "output": str(reference),
                                           "seed": seed, "style": style.strip(), "environment": method == "projected-photo"})
            pixels = reference.read_bytes()
            (directory / "frame.png").write_bytes(pixels)
        except (OSError, RuntimeError, TimeoutError) as error:
            req.app.logger.error("Opening reference generation failed: %s", error)
            raise web.HTTPServiceUnavailable(reason="opening reference generation failed")
        digest = sha256(pixels).hexdigest()
        metadata = {"context": context, "method": method, "style": style.strip(), "seed": seed,
                    "openTick": tick, "referenceSha256": digest}
        (directory / "session.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
        session = WorldSession(name, context, method, style.strip(), seed, directory, tick, digest)
        self.sessions[name] = session
        if len(self.sessions) > 24:
            self.sessions.popitem(last=False)
        return session.frame(key, ms, reference=True)

    async def frame(self, req):
        data, key, tick, context, image = await observation_payload(req)
        session_id = data.get("sessionId")
        session = self.sessions.get(session_id) if isinstance(session_id, str) else None
        if session is None:
            raise web.HTTPNotFound(reason="reference session unavailable")
        if session.method in ("eden-stream", "projected-photo"):
            raise web.HTTPConflict(reason="this backend does not use per-step render requests")
        if context != session.context:
            raise web.HTTPConflict(reason="CityNav task changed; generate a new opening reference")
        self.sessions.move_to_end(session_id)
        async with session.lock:
            if tick < session.tick:
                raise web.HTTPConflict(reason="CityNav observation moved backwards")
            if tick == session.tick:
                return session.frame(key, 0)
            directory = session.directory
            current, output = directory / "next-proxy.png", directory / "next-frame.png"
            current.unlink(missing_ok=True)
            output.unlink(missing_ok=True)
            image.save(current)
            control = {}
            if session.method == "cosmos":
                depth = directory / "depth.png"
                save_control(data, "depth", depth, (256, 144), "L")
                control["depth"] = str(depth)
            elif session.method in ALTERNATIVES:
                control = alternative_controls(session.method, data, directory, image.size)
            try:
                started = time.perf_counter()
                job = {
                    "id": key, "session": session.id, "tick": tick, "previousTick": session.tick,
                    "proxy": str(current), "previous": str(directory / "proxy.png"),
                    "opening": str(directory / "opening-proxy.png"),
                    "reference": str(directory / "reference.png"), "output": str(output),
                    "style": session.style, "seed": session.seed, **control,
                }
                if session.method == "cosmos":
                    await self.cosmos_frame(job)
                else:
                    await self.renderers[session.method].run(job)
                if session.method == "cosmos" or session.method in ALTERNATIVES:
                    correct_rendered_signals(output, image, data.get("signalRegions"))
                output.replace(directory / "frame.png")
                current.replace(directory / "proxy.png")
            except (OSError, RuntimeError, TimeoutError) as error:
                req.app.logger.error("Reference video render failed: %s", error)
                raise web.HTTPServiceUnavailable(reason="reference video render failed")
            session.tick = tick
            return session.frame(key, (time.perf_counter() - started) * 1000)

    async def cleanup(self, _):
        await asyncio.gather(self.editor.stop(), *(proc.stop() for proc in self.renderers.values()))
