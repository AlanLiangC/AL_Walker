"""One persistent process per GPU, using the released Reactor inference backend."""
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import asyncio
import multiprocessing
import os
import time

import numpy as np
import psutil

from .appearance import Appearance

_backend = None


class AdaEden:
    def __init__(self, profile, source, weights):
        import sys
        import torch

        torch.set_num_threads(4)
        sys.path.insert(0, str(Path(source) / "reactor"))
        from edenlive_backend import EdenBackend
        from edenlive_model import EdenAnchor

        self.latent_chunk = profile.get("latentChunk", 3)
        native_options = dict(source=Path(source), weights=Path(weights), attention_backend="native",
                              cuda_graph=profile.get("cudaGraph", False), compile_model=profile.get("compile", False))
        history = profile.get("historyLatents")
        if self.latent_chunk == 3 and history is None:
            self.native = EdenBackend(**native_options)
        else:
            for directory in ("realtime/flashdreams", "realtime/integrations_v2"):
                sys.path.insert(0, str(Path(source) / directory))
            from eden import game5b_config
            from flashdreams.infra.config import derive_config

            recipe = game5b_config.PIPELINE_GAME2V_EDEN_WORLD_V2_5B_TAEHV
            overrides = {"len_t": self.latent_chunk}
            if history is not None:
                overrides["window_size_t"] = history
            game5b_config.PIPELINE_GAME2V_EDEN_WORLD_V2_5B_TAEHV = derive_config(
                recipe, diffusion_model={"transformer": overrides},
            )
            try:
                self.native = EdenBackend(**native_options)
            finally:
                game5b_config.PIPELINE_GAME2V_EDEN_WORLD_V2_5B_TAEHV = recipe
        self.anchor_cls = EdenAnchor
        self.torch = self.native.torch
        self.profile = profile
        self.control_scale = profile.get("controlScale", 1.0)
        self.width, self.height = profile["width"], profile["height"]
        if schedule := profile.get("denoisingTimesteps"):
            from flashdreams.infra.config import derive_config

            model = self.native.pipeline.diffusion_model
            config = derive_config(model.scheduler.config, num_inference_steps=len(schedule),
                                   denoising_timesteps=schedule)
            model.scheduler = config.setup().to("cuda")
        if profile.get("fp8"):
            from .ada import install_fp8

            install_fp8(self.native.pipeline.diffusion_model.transformer.network)
        if profile.get("sage"):
            from .ada import install_sage

            install_sage(self.native.pipeline.diffusion_model.transformer.network)
        if backend := profile.get("sdpa"):
            from flashdreams.core.attention.native import NativeAttention

            for module in self.native.pipeline.diffusion_model.transformer.network.modules():
                if isinstance(module, NativeAttention):
                    module.backend = backend
        if profile.get("decoder") == "WanVAE":
            from flashdreams.recipes.wan.autoencoder.vae import Wan22TI2V5BVAEDecoderConfig, WanVAEDecoder

            config = Wan22TI2V5BVAEDecoderConfig(
                checkpoint_path=str(Path(weights) / "vae-5b/Wan2.2_VAE.pth"),
            )
            if window := profile.get("decoderLatentWindow"):
                class WindowedWanDecoder(WanVAEDecoder):
                    def forward(self, input, autoregressive_index=0, cache=None):
                        if cache is None:
                            cache = self.initialize_autoregressive_cache()
                        # The Wan decoder is causal. Keep its history while limiting
                        # activations to one small temporal window at a time.
                        decode = super().forward
                        frames = [decode(part, autoregressive_index, cache) for part in input.split(window, dim=-4)]
                        return torch.cat(frames, dim=-4)

                config._target = WindowedWanDecoder
                config.use_cuda_graph = False
            self.native.pipeline.decoder = config.setup().to("cuda").eval()
        # Exhaustive convolution autotuning can take minutes on a cold Ada worker.
        self.torch.backends.cudnn.benchmark = False
        self.torch.cuda.synchronize()
        self.index = 0

    def open(self, pixels, prompt, seed):
        self.native.reset()
        self.index = 0
        t = self.torch
        if (self.width, self.height) == (1280, 704):
            self.native.start(self.anchor_cls(image=pixels, prompt=prompt, seed=seed))
        else:
            # Reactor fixes its surface to 720p. The native pipeline takes the VAE
            # size from its reference tensor, and DINO takes the resulting latent grid.
            with t.no_grad():
                image = t.from_numpy(pixels).permute(2, 0, 1)[None].to("cuda", t.float32) / 127.5 - 1
                diffusion = self.native.pipeline.diffusion_model
                diffusion.config.seed = seed
                diffusion._rng = None
                diffusion._initial_video_noise = None
                self.native.anchor_embeddings(prompt)
                self.native.cache = self.native.pipeline.initialize_cache(
                    text=[prompt], image=image.contiguous(), release_oneshot_encoders=False,
                )
                self.native.prompt = prompt

    def generate(self, condition, anchor, prompt, seed):
        t = self.torch
        stats = {}
        if anchor is not None:
            t.cuda.reset_peak_memory_stats()
            begun = time.perf_counter()
            self.open(anchor, prompt, seed)
            t.cuda.synchronize()
            stats["anchorMs"] = (time.perf_counter() - begun) * 1000
        with t.no_grad():
            if prompt != self.native.prompt:
                started = time.perf_counter()
                embeddings = self.native.text_embeddings(prompt)
                self.native.pipeline.replace_text_embeddings(self.native.cache, embeddings)
                self.native.prompt = prompt
                stats["promptSwitchMs"] = (time.perf_counter() - started) * 1000
            begin, encoded, generated, decoded = (t.cuda.Event(enable_timing=True) for _ in range(4))
            begin.record()
            control = self.native.dino.encode(
                self.native.condition_pixels(condition), latent_height=self.height // 16,
                latent_width=self.width // 16, dtype=t.bfloat16,
            )
            if self.control_scale != 1:
                control.mul_(self.control_scale)
            encoded.record()
            pipeline = self.native.pipeline
            decoder = pipeline.decoder
            before = decoder.register_forward_pre_hook(lambda *_: generated.record())
            after = decoder.register_forward_hook(lambda *_: decoded.record())
            try:
                frames = pipeline.generate(autoregressive_index=self.index, cache=self.native.cache, input=control)
            finally:
                before.remove()
                after.remove()
            rgb = ((frames.float().clamp(-1, 1) + 1) * 127.5).round()
            rgb = rgb.to(t.uint8).permute(0, 2, 3, 1).contiguous()
            pixels = t.empty(rgb.shape, dtype=t.uint8, pin_memory=True)
            pixels_ready = t.cuda.Event()
            pixels.copy_(rgb, non_blocking=True)
            pixels_ready.record()
            # KV finalization stays on the same CUDA stream. Its kernels can
            # complete while the already-decoded RGB is encoded for transport.
            pipeline.finalize(autoregressive_index=self.index, cache=self.native.cache)
            if self.profile.get("asyncFinalize"):
                pixels_ready.synchronize()
            else:
                t.cuda.synchronize()
            stats.update(dinoMs=begin.elapsed_time(encoded), gpuPeakMiB=t.cuda.max_memory_reserved() / 1048576)
            if generated.query() and decoded.query():
                stats.update(denoiseMs=encoded.elapsed_time(generated), decodeMs=generated.elapsed_time(decoded))
        expected = 4 * self.latent_chunk - (3 if self.index == 0 else 0)
        self.index += 1
        output = pixels.numpy()
        if output.shape != (expected, self.height, self.width, 3):
            raise RuntimeError(f"Unexpected EdenLive output shape {output.shape}")
        return output, stats

    def reset(self):
        self.native.reset()
        self.index = 0


def initialize(gpu, profile, source, weights):
    global _backend
    os.environ["CUDA_VISIBLE_DEVICES"] = gpu
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    if profile["backend"] == "regen":
        from .regen import Regen

        _backend = Regen(profile, source, weights)
    else:
        _backend = AdaEden(profile, source, weights)


def warm():
    begun = time.perf_counter()
    t = _backend.torch
    frame = np.zeros((_backend.height, _backend.width, 3), dtype=np.uint8)
    samples = np.stack([frame] * _backend.latent_chunk)
    prompt = Appearance().prompt("day")
    stages = []
    count = 10 if _backend.profile.get("cudaGraph") or _backend.profile.get("compile") else 2
    for index in range(count):
        started = time.perf_counter()
        output, stats = _backend.generate(samples, frame if index == 0 else None, prompt, 0)
        stages.append({"frames": len(output), "ms": (time.perf_counter() - started) * 1000, **stats})
    _backend.reset()
    return {"pid": os.getpid(), "device": t.cuda.get_device_name(), "capability": t.cuda.get_device_capability(),
            "memoryMiB": t.cuda.get_device_properties(0).total_memory // 1048576,
            "bf16": t.cuda.is_bf16_supported(including_emulation=False),
            "torch": t.__version__, "seconds": time.perf_counter() - begun, "warmup": stages}


def generate(condition, anchor, prompt, seed):
    started = time.perf_counter()
    output, stats = _backend.generate(condition, anchor, prompt, seed)
    return output, {"workerMs": (time.perf_counter() - started) * 1000, **stats}


def reset():
    _backend.reset()


class GpuWorker:
    def __init__(self, gpu, profile, source, weights):
        self.gpu = gpu
        self.args = gpu, profile, source, weights
        self.executor = None
        self.ready = False
        self.in_use = False
        self.info = None
        self.process = None

    async def start(self):
        self.ready = False
        started = time.perf_counter()
        self.executor = ProcessPoolExecutor(
            max_workers=1, mp_context=multiprocessing.get_context("spawn"),
            initializer=initialize, initargs=self.args,
        )
        try:
            self.info = await self.run(warm)
            self.process = psutil.Process(self.info["pid"])
            self.info["loadAndWarmSeconds"] = time.perf_counter() - started
        except BaseException:
            self.shutdown()
            raise
        self.ready = True
        return self.info

    async def run(self, func, *args):
        return await asyncio.get_running_loop().run_in_executor(self.executor, func, *args)

    def shutdown(self):
        self.ready = False
        self.process = None
        if self.executor is not None:
            self.executor.shutdown(wait=False, cancel_futures=True)
            self.executor = None

    def abort(self):
        if self.process is not None:
            try:
                self.process.kill()
            except psutil.NoSuchProcess:
                pass


class PassthroughWorker:
    ready = True
    info = None

    def __init__(self, index):
        self.gpu = f"cpu-{index}"
        self.in_use = False
