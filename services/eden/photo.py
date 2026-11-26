"""A persistent geometry renderer which consumes an immutable CityNav snapshot."""
import asyncio
from collections import deque
import json
import math
import os
from pathlib import Path
import tempfile
import uuid

from aiohttp import web


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


class PhotoRenderer:
    def __init__(self, blender, worker, scene, style, gpu, compute, generative=None):
        self.command = (
            str(blender), "--background", "--factory-startup", "--threads", "4", "--python-exit-code", "1",
            "--python", str(worker), "--", str(scene), str(style), compute,
        )
        self.env = {**os.environ, "CUDA_VISIBLE_DEVICES": gpu}
        self.scene = json.loads(scene.read_text())
        self.style = json.loads(style.read_text())
        self.generative = generative
        self.process = None
        self.lock = asyncio.Lock()
        self.recent_log = deque(maxlen=10)

    async def config(self, _):
        methods = [{"id": "cycles", "label": "Blender Cycles", "timeout": 120, "available": True}]
        if self.generative:
            methods.extend(self.generative.profiles())
        return web.json_response({
            "scene": self.scene["scene"], "width": self.style["width"], "height": self.style["height"],
            "weather": "day", "backend": "cycles", "methods": methods,
        })

    def valid(self, state):
        try:
            camera = state["camera"]
            eye, target = camera["eye"], camera["target"]
            return (
                state["scene"] == self.scene["scene"] and state["weather"] == "day"
                and type(state["tick"]) is int and state["tick"] >= 0
                and len(eye) == len(target) == 3 and all(finite(v) for v in [*eye, *target]) and eye != target
                and finite(camera["fov"]) and 20 <= camera["fov"] <= 150
                and finite(camera["far"]) and 1 < camera["far"] <= 300
                and len(state["actors"]) <= 500 and len({a["id"] for a in state["actors"]}) == len(state["actors"])
                and all(isinstance(a["id"], str) and 0 < len(a["id"]) <= 100 and a["mesh"] in self.scene["actors"]
                        and all(finite(a[key]) for key in ("x", "y", "z", "yaw"))
                        and ((type(a["stride"]) is int and -2 <= a["stride"] <= 2) if a["mesh"].startswith("pedestrian:")
                             else "stride" not in a)
                        for a in state["actors"])
                and all(type(state["signals"][p["crossing"]]) is bool for p in self.scene["posts"])
            )
        except (KeyError, TypeError, IndexError, OverflowError):
            return False

    async def read_reply(self):
        while line := await self.process.stdout.readline():
            if line.startswith(b"CITYNAV "):
                return json.loads(line[8:])
            self.recent_log.append(line.decode(errors="replace").strip())
        raise RuntimeError("Blender exited: " + " ".join(self.recent_log))

    async def start(self):
        if self.process is None:
            self.recent_log.clear()
            self.process = await asyncio.create_subprocess_exec(
                *self.command, env=self.env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
            )
            if not (await self.read_reply()).get("ready"):
                raise RuntimeError("Blender did not initialize")

    async def stop(self):
        if self.process is not None:
            if self.process.returncode is None:
                try:
                    self.process.kill()
                except ProcessLookupError:
                    pass
            await self.process.wait()
            self.process = None

    async def frame(self, req):
        try:
            state = await req.json()
            key, method = state["key"], state.get("method", "cycles")
            methods = self.generative.style["methods"] if self.generative else {}
            stream = state.get("stream", key)
            if (str(uuid.UUID(key)) != key or str(uuid.UUID(stream)) != stream
                    or (method != "cycles" and method not in methods) or not self.valid(state)):
                raise ValueError
        except (ValueError, KeyError, TypeError, AttributeError):
            raise web.HTTPBadRequest(reason="invalid or unsupported CityNav render state")
        enhanced = method != "cycles"
        if enhanced and not self.generative.available(method):
            raise web.HTTPServiceUnavailable(reason="local renderer weights or runtime are missing")
        async with self.lock:
            with tempfile.TemporaryDirectory(prefix="citynav-photo-") as directory:
                target = Path(directory) / "frame.png"
                try:
                    async with asyncio.timeout(120):
                        await self.start()
                        job = {"state": state, "output": str(target), "id": key, "controls": enhanced}
                        self.process.stdin.write((json.dumps(job, allow_nan=False) + "\n").encode())
                        await self.process.stdin.drain()
                        result = await self.read_reply()
                        if result.get("id") != key or "error" in result:
                            raise RuntimeError(result.get("error", "unexpected Blender response"))
                        data = target.read_bytes()
                except (OSError, RuntimeError, TimeoutError, asyncio.CancelledError) as error:
                    await self.stop()
                    if isinstance(error, asyncio.CancelledError):
                        raise
                    req.app.logger.error("Cycles renderer failed: %s", error)
                    raise web.HTTPServiceUnavailable(reason="scene renderer failed")
                if enhanced:
                    try:
                        controls = next(Path(directory).glob("controls-*.exr"), None)
                        if controls is None:
                            raise RuntimeError("Cycles did not produce control passes")
                        data, ms = await self.generative.render(method, state, target, controls,
                                                                 Path(directory) / "generated.png")
                        result["ms"] += ms
                    except (OSError, RuntimeError, TimeoutError, asyncio.CancelledError) as error:
                        await self.generative.stop()
                        if isinstance(error, asyncio.CancelledError):
                            raise
                        req.app.logger.error("%s renderer failed: %s", method, error)
                        raise web.HTTPServiceUnavailable(reason=f"{method} renderer failed")
        return web.Response(body=data, content_type="image/png", headers={
            "X-CityNav-Frame": key, "X-CityNav-Tick": str(state["tick"]),
            "X-CityNav-Method": method, "X-CityNav-Render-Ms": f'{result["ms"]:.1f}',
        })
