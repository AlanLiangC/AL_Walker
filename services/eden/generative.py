"""Local diffusion methods for the CityNav photo endpoint."""
import asyncio
from collections import deque
import json
import os
from pathlib import Path
import sys


class GenerativeRenderer:
    def __init__(self, repo, root, public, config, gpu):
        self.repo, self.root, self.public, self.config = repo, root, public, config
        self.weights = root / "models/visual"
        self.style = json.loads(config.read_text())
        self.worker = repo / "tools/visual/generate-frame.py"
        self.env = {**os.environ, "CUDA_VISIBLE_DEVICES": gpu, "HF_HUB_OFFLINE": "1",
                    "TRANSFORMERS_OFFLINE": "1", "OPENCV_IO_ENABLE_OPENEXR": "1"}
        self.process = None
        self.method = None
        self.log = deque(maxlen=12)

    @property
    def qwen(self):
        local = self.weights / "qwen-image-21"
        return local if local.is_dir() else self.public / "Qwen-Image-2.1"

    def available(self, method):
        required = {
            "edenlive": [self.root / "upstream/reactor/edenlive_backend.py",
                         self.root / "models/EdenLive/dit-5b/diffusion_pytorch_model.safetensors"],
            "qwen-image": [self.root / "visual/python/diffusers/pipelines/qwenimage21/pipeline_qwenimage21.py",
                           self.qwen / "transformer/diffusion_pytorch_model-00002-of-00002.safetensors",
                           self.qwen / "text_encoder/model-00004-of-00004.safetensors"],
            "difix": [self.root / "visual/difix-source/src/pipeline_difix.py",
                      self.root / "visual/difix-python/peft/__init__.py",
                      self.weights / "difix/vae/autoencoder_kl.py",
                      self.weights / "difix/text_encoder/model.safetensors",
                      self.weights / "difix/unet/diffusion_pytorch_model.safetensors",
                      self.weights / "difix/vae/diffusion_pytorch_model.safetensors"],
            "sdxl-depth": [self.weights / f"sdxl/{part}/{file}.fp16.safetensors"
                           for part, file in (("unet", "diffusion_pytorch_model"), ("vae", "diffusion_pytorch_model"),
                                              ("text_encoder", "model"), ("text_encoder_2", "model"))]
                          + [self.weights / "sdxl-depth/diffusion_pytorch_model.fp16.safetensors"],
            "wan-vace": [self.weights / f"wan-vace/transformer/diffusion_pytorch_model-0000{i}-of-00002.safetensors"
                         for i in (1, 2)]
                        + [self.weights / "wan-vace/vae/diffusion_pytorch_model.safetensors",
                           self.root / "models/EdenLive/umt5/text_encoder/model.safetensors"],
        }
        return all(file.is_file() and file.stat().st_size for file in required[method])

    def profiles(self):
        return [{"id": method, "label": options["label"], "timeout": options["timeout"],
                 "available": self.available(method)} for method, options in self.style["methods"].items()]

    async def reply(self):
        while line := await self.process.stdout.readline():
            if line.startswith(b"CITYNAV "):
                return json.loads(line[8:])
            self.log.append(line.decode(errors="replace").strip())
        raise RuntimeError("Model worker exited: " + " ".join(self.log))

    async def start(self, method):
        if self.process is None or method != self.method:
            await self.stop()
            self.method = method
            env = self.env.copy()
            overlay = {"qwen-image": "python", "difix": "difix-python"}.get(method)
            if overlay:
                env["PYTHONPATH"] = str(self.root / "visual" / overlay) + os.pathsep + env.get("PYTHONPATH", "")
            self.log.clear()
            self.process = await asyncio.create_subprocess_exec(
                sys.executable, "-u", str(self.worker), method, str(self.root), str(self.qwen), str(self.config),
                cwd=self.repo, env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT, limit=512_000,
            )
            if not (await self.reply()).get("ready"):
                raise RuntimeError("Model worker failed to initialize")

    async def stop(self):
        if self.process is not None:
            if self.process.returncode is None:
                try:
                    self.process.kill()
                except ProcessLookupError:
                    pass
            await self.process.wait()
            self.process = None

    async def render(self, method, state, rgb, controls, output):
        async with asyncio.timeout(self.style["methods"][method]["timeout"]):
            await self.start(method)
            job = {"id": state["key"], "tick": state["tick"], "stream": state.get("stream", state["key"]),
                   "context": {k: state.get(k) for k in ("episodeId", "robotId", "seed", "weather", "camera")},
                   "rgb": str(rgb), "controls": str(controls), "output": str(output)}
            self.process.stdin.write((json.dumps(job) + "\n").encode())
            await self.process.stdin.drain()
            reply = await self.reply()
            if reply.get("id") != state["key"] or "error" in reply:
                raise RuntimeError(reply.get("error", "unexpected model response"))
            return output.read_bytes(), reply["ms"]
