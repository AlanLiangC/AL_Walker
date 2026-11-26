"""WebRTC admission, bounded buffering and frame provenance for CityNav."""
from collections import OrderedDict, deque
from fractions import Fraction
import asyncio
from io import BytesIO
import json
import logging
import math
import time

from aiortc import MediaStreamTrack, RTCConfiguration, RTCIceServer, RTCPeerConnection
from aiortc.mediastreams import MediaStreamError
import numpy as np
from PIL import Image, ImageFilter

from .rtc.frames import InputFrame, pack, read_input
from .worker import generate

logger = logging.getLogger("citynav.eden")
CLOCK = 90_000


def correct_signal_color(pixels, source, regions):
    if not isinstance(regions, list) or not regions:
        return pixels, 0
    height, width = pixels.shape[:2]
    corrected = None
    lenses = 0
    for region in regions[:20]:
        if not isinstance(region, list) or len(region) != 5 or type(region[4]) is not bool:
            continue
        *coords, walk = region
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in coords):
            continue
        x0, y0, x1, y1 = [round(max(0, min(1, value))*scale)
                          for value, scale in zip(coords, (width, height, width, height))]
        if x1-x0 < 3 or y1-y0 < 3 or (x1-x0)*(y1-y0) > .08*width*height:
            continue
        original = source[y0:y1, x0:x1].astype(np.int16)
        red, green, blue = original.transpose(2, 0, 1)
        visible = ((green > 135) & (green-red > 38) & (green-blue > 28)) if walk else (
            (red > 135) & (red-green > 42) & (red-blue > 42))
        if np.count_nonzero(visible) < 3:
            continue
        output = pixels[y0:y1, x0:x1].astype(np.int16)
        red, green, blue = output.transpose(2, 0, 1)
        level = np.maximum(red, green)
        # Keep the generated reflection and housing. Only recolor a visible
        # chromatic lens in the small region supported by CityNav's source.
        wrong = red > green*.72 if walk else green > red*.49
        nearby = np.asarray(Image.fromarray(visible.astype(np.uint8)).filter(ImageFilter.MaxFilter(7))) != 0
        lens = (level > 105) & (level-blue > 35) & wrong & nearby
        if np.count_nonzero(lens) < 2:
            continue
        if corrected is None:
            corrected = pixels.copy()
        target = np.array((.23, 1, .51) if walk else (1, .21, .16))
        corrected[y0:y1, x0:x1][lens] = (output[lens]*.08+level[lens, None]*target*.92).astype(np.uint8)
        lenses += 1
    return (pixels if corrected is None else corrected), lenses


def aligned_camera(expected, actual):
    try:
        a = [*expected["eye"], *expected["target"], expected["fov"]]
        b = [*actual["eye"], *actual["target"], actual["fov"]]
        return len(a) == len(b) == 7 and all(math.isclose(x, y, abs_tol=0.0001) for x, y in zip(a, b))
    except (KeyError, TypeError):
        return False


def log(event, **values):
    logger.info(json.dumps({"event": event, "serverAt": time.monotonic() * 1000, **values},
                           ensure_ascii=False, separators=(",", ":")))


class PairedVideo(MediaStreamTrack):
    kind = "video"

    def __init__(self, session):
        super().__init__()
        self.session = session
        self.pts = -1
        self.last_at = 0.0
        self.time_offset = None

    async def next_row(self):
        row = await self.session.playback.get()
        if row is None:
            raise MediaStreamError
        source, enhanced, meta = row
        if self.session.reference and meta.get("mapping") != "reference":
            enhanced, corrected = correct_signal_color(enhanced, source.pixels, source.meta.get("signalRegions"))
            if corrected:
                meta = {**meta, "correctedSignalRegions": corrected}
        now = time.monotonic()
        if self.session.worker_mode:
            captured = source.meta["capturedAt"] / 1000
            interval = 1 / self.session.profile["fps"]
            if self.session.reference:
                clock = source.received_at - captured
                self.time_offset = clock if self.time_offset is None else min(self.time_offset, clock)
                delay = self.session.profile.get("livePlaybackMs", 600) / 1000
                target = max(self.time_offset + captured + delay, self.last_at + interval * .72)
            else:
                new_rollout = meta["fresh"] and source.meta["frameId"] == meta["range"][0]
                if self.time_offset is None or (new_rollout and abs(now - (self.time_offset + captured)) > 2 * interval):
                    self.time_offset = now - captured
                target = max(self.time_offset + captured, self.last_at + interval / 3)
            await asyncio.sleep(max(0, target - now))
        if self.session.closed:
            raise MediaStreamError
        self.last_at = time.monotonic()
        return source, enhanced, meta

    async def recv(self):
        source, enhanced, meta = await self.next_row()
        if self.session.output_id >= 0xFFFFFF:
            raise MediaStreamError
        base = self.session.opened
        self.pts = max(self.pts + 1, round((self.last_at - base) * CLOCK))
        output_id = self.session.output_id
        self.session.output_id += 1
        start = time.monotonic()
        frame = pack(None if self.session.reference else source.pixels, enhanced, output_id)
        frame.pts = self.pts
        frame.time_base = Fraction(1, CLOCK)
        self.session.send("output", outputId=output_id, frameId=source.meta["frameId"],
                          simTick=source.meta["simTick"], inputPts=source.pts, outputPts=self.pts,
                          serverAgeMs=(self.last_at-source.received_at)*1000,
                          packingMs=(time.monotonic()-start)*1000, **meta)
        if self.session.playback.empty():
            self.session.output_clear.set()
        return frame


def read_image_packet(data, size):
    header = int.from_bytes(data[:4], "big")
    if not 1 <= header <= 4096 or len(data) <= header + 4:
        raise ValueError("invalid media packet")
    value = json.loads(data[4:4+header])
    with Image.open(BytesIO(data[4+header:])) as image:
        if image.format != "JPEG" or image.size != size:
            raise ValueError("invalid media image")
        return value, np.asarray(image.convert("RGB")).copy()


def jpeg_packet(meta, image):
    with BytesIO() as output:
        Image.fromarray(image).save(output, "JPEG", quality=94, subsampling=0)
        header = json.dumps(meta, separators=(",", ":")).encode()
        return len(header).to_bytes(4, "big") + header + output.getvalue()


class Session:
    def __init__(self, key, epoch, context, worker, profile, release, references, ice_servers, appearance,
                 *, reference=None, socket=None):
        self.key, self.epoch, self.context = key, epoch, context
        self.worker, self.profile, self.release = worker, profile, release
        self.references = references
        self.appearance = appearance
        self.socket = socket
        self.peer = (None if socket is not None else
                     RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(**item) for item in ice_servers])))
        self.width, self.height = profile["width"], profile["height"]
        self.chunk_frames = 4 * profile.get("latentChunk", 3)
        self.worker_mode = profile["backend"] == "edenlive"
        self.regen = profile["backend"] == "regen"
        self.reference = reference
        self.reference_pixels = None
        self.last_render = None
        if reference:
            with Image.open(reference.directory / "reference.png") as image:
                self.reference_pixels = np.asarray(image.convert("RGB").resize((self.width, self.height),
                                                                             Image.Resampling.LANCZOS)).copy()
        self.prompt = appearance.prompt(context["weather"])
        self.opened = self.last_input = time.monotonic()
        self.closed = False
        self.meta = OrderedDict()
        self.unmatched = OrderedDict()
        self.last_frame_id = 0
        self.pending = deque()
        self.input_ready = asyncio.Event()
        self.output_clear = asyncio.Event()
        self.output_clear.set()
        self.playback = asyncio.Queue(maxsize=12)
        self.output_id = 1
        self.channel = None
        self.tracks = []
        self.jobs = set()
        self.inflight = None
        self.overflown = False
        self.source_count = 0
        self.track = PairedVideo(self)
        if self.peer is not None:
            self.bind_peer()

    def bind_peer(self):
        @self.peer.on("connectionstatechange")
        async def connection():
            if self.peer.connectionState in ("failed", "closed", "disconnected"):
                await self.close("peer-" + self.peer.connectionState)

        @self.peer.on("datachannel")
        def datachannel(channel):
            if channel.label != "citynav" or self.channel is not None:
                channel.close()
                return
            self.channel = channel
            channel.on("message", self.input_meta)
            channel.on("close", lambda: asyncio.create_task(self.close("channel-closed")))

        @self.peer.on("track")
        def track_received(track):
            if track.kind != "video" or self.tracks:
                track.stop()
                return
            self.tracks.append(track)
            self.spawn(self.read_video(track))

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.jobs.add(task)
        task.add_done_callback(self.jobs.discard)

    def start(self):
        self.spawn(self.process())
        self.spawn(self.expire())
        if self.socket is not None:
            self.spawn(self.send_images())
        log("session-open", sessionId=self.key, epoch=self.epoch, gpu=self.worker.gpu,
            referenceSha256=self.reference.digest if self.reference else None,
            prompt=self.prompt if self.worker_mode and not self.reference else None, **self.context)

    def send(self, kind, **values):
        data = {"type": kind, "sessionId": self.key, "epoch": self.epoch, **values}
        channel = self.channel
        if channel and channel.readyState == "open" and channel.bufferedAmount < 256_000:
            channel.send(json.dumps(data, separators=(",", ":")))
        if kind in ("output", "drop", "failure"):
            log(kind, gpu=self.worker.gpu, **data)
        if self.socket is not None and kind != "output" and not self.socket.closed:
            self.spawn(self.socket.send_json(data))

    def input_meta(self, raw):
        if self.closed or not isinstance(raw, str) or len(raw) > 4096:
            return
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                return
            if not self.valid_input(value):
                return
        except (ValueError, KeyError):
            return
        frame_id = value["frameId"]
        self.meta[frame_id] = value
        self.try_match(frame_id)
        self.trim(self.meta, 64, "no-video")

    def trim(self, buffer, size, reason):
        while len(buffer) > size:
            frame_id, _ = buffer.popitem(last=False)
            self.send("drop", frameId=frame_id, reason=reason)

    async def read_video(self, track):
        try:
            while not self.closed:
                frame = await track.recv()
                self.source_count += 1
                frame_id, error = read_input(frame, self.width, self.height)
                if error:
                    self.send("drop", reason=error, inputPts=frame.pts)
                    continue
                if frame_id <= self.last_frame_id:
                    self.send("drop", frameId=frame_id, reason="old-or-duplicate-input")
                    continue
                self.unmatched[frame_id] = (frame, time.monotonic())
                self.try_match(frame_id)
                self.trim(self.unmatched, 16, "no-metadata")
        except MediaStreamError:
            await self.close("input-ended")
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Input video failed for %s", self.key)
            await self.close("input-error")

    def try_match(self, frame_id):
        if frame_id not in self.meta or frame_id not in self.unmatched:
            return
        frame, received = self.unmatched.pop(frame_id)
        values = self.meta.pop(frame_id)
        for old in [key for key in self.meta if key < frame_id]:
            self.meta.pop(old)
            self.send("drop", frameId=old, reason="encoder-or-network")
        for old in [key for key in self.unmatched if key < frame_id]:
            self.unmatched.pop(old)
            self.send("drop", frameId=old, reason="no-metadata")
        # The 16-line tag is removed before any conditioning or reference encoding.
        image = np.ascontiguousarray(frame.to_ndarray(format="rgb24")[: self.height])
        self.enqueue(values, image, frame.pts, received)

    def valid_input(self, value):
        frame_id, tick, captured = value["frameId"], value["simTick"], value["capturedAt"]
        return (value.get("type") == "input" and value.get("sessionId") == self.key
                and value.get("epoch") == self.epoch and type(frame_id) is int
                and self.last_frame_id < frame_id <= 0xFFFFFF and type(tick) is int
                and 0 <= tick <= 10_000_000 and type(captured) in (float, int) and math.isfinite(captured))

    def enqueue(self, values, image, pts, received):
        self.last_frame_id = values["frameId"]
        self.last_input = received
        # A running chunk still needs its three trailing source frames. Leave
        # room for those and the next chunk while inference is in flight.
        limit = self.chunk_frames + 4 if self.reference else self.chunk_frames if self.worker_mode else 1
        if len(self.pending) == limit:
            skipped = self.pending.popleft()
            self.send("drop", frameId=skipped.meta["frameId"], reason="input-backpressure")
            self.overflown = True
        self.pending.append(InputFrame(values, image, pts, received))
        self.input_ready.set()

    async def socket_input(self, data):
        received = time.monotonic()
        try:
            value, image = await asyncio.to_thread(read_image_packet, data, (self.width, self.height))
            if isinstance(value, dict) and self.valid_input(value):
                self.source_count += 1
                self.enqueue(value, image, value["frameId"], received)
        except (KeyError, OSError, TypeError, ValueError):
            return

    async def send_images(self):
        try:
            while not self.closed:
                source, image, common = await self.track.next_row()
                meta = {"type": "output", "sessionId": self.key, "epoch": self.epoch,
                        "outputId": self.output_id, "frameId": source.meta["frameId"],
                        "simTick": source.meta["simTick"], "serverAgeMs": (time.monotonic()-source.received_at)*1000,
                        **common}
                self.output_id += 1
                if self.regen:
                    image = np.concatenate((source.pixels, image), axis=1)
                packet = await asyncio.to_thread(jpeg_packet, meta, image)
                await self.socket.send_bytes(packet)
                if self.playback.empty():
                    self.output_clear.set()
        except (ConnectionError, MediaStreamError):
            await self.close("socket-ended")

    async def infer(self, condition, anchor=None, prompt=None, seed=0):
        self.inflight = asyncio.create_task(self.worker.run(generate, condition, anchor, prompt, seed))
        try:
            result = await asyncio.wait_for(
                asyncio.shield(self.inflight), timeout=self.profile.get("inferenceTimeoutMs", 30_000)/1000)
        except TimeoutError:
            self.worker.abort()
            raise
        self.inflight = None
        return result

    async def process(self):
        fresh = True
        chunk = 0
        try:
            while not self.closed:
                restart = fresh or self.overflown and self.reference is None
                condition_count = self.chunk_frames - 3 if self.worker_mode else 1
                count = condition_count if restart or not self.worker_mode else self.chunk_frames
                if len(self.pending) < condition_count:
                    self.input_ready.clear()
                    await self.input_ready.wait()
                    continue
                reset_history = restart and not fresh
                fresh = restart
                self.overflown = False
                if reset_history and self.worker_mode:
                    log("history-resync", sessionId=self.key, epoch=self.epoch, gpu=self.worker.gpu)
                batch = [self.pending.popleft() for _ in range(condition_count)]
                begin = time.monotonic()
                first = batch[0]
                stats = {"workerMs": 0}
                anchor_kind = "source"
                held = self.reference and self.last_render is not None and all(
                    row.meta["simTick"] == self.last_render[0] for row in batch)
                if held:
                    count = condition_count
                signal = first.meta.get("signalState")
                if signal not in ("stop", "walk", "yield", "full-stop"):
                    signal = None
                if self.worker_mode:
                    target = None
                    if fresh:
                        target = first.pixels
                        if self.reference:
                            target, anchor_kind = self.reference_pixels, "reference"
                        else:
                            for pixels, camera, tick in self.references:
                                if first.meta["simTick"] == tick and aligned_camera(camera, first.meta.get("camera")):
                                    target = pixels
                                    anchor_kind = "reference"
                                    break
                    if held:
                        enhanced = [self.last_render[1]] * count
                    else:
                        condition = np.stack([source.pixels for source in batch[::4]])
                        seed = self.context["seed"]
                        prompt = self.appearance.prompt(self.context["weather"], signal)
                        if self.reference:
                            prompt = (f"{self.reference.style}. Real footage from the exact low camera and motion in the "
                                      "input. Keep reference materials and lighting. Retain road edges, individual "
                                      "vehicles, people, glass, and their positions and headings. Traffic signal lenses "
                                      "follow the control images. Vehicle paint stays consistent as signals change.")
                            seed = self.reference.seed
                        enhanced, stats = await self.infer(condition, target, prompt, seed)
                    tail = count-condition_count
                    # The three trailing inputs can arrive during inference.
                    # A discontinuity invalidates the synthesized tail.
                    while len(self.pending) < tail and not self.overflown:
                        self.input_ready.clear()
                        await self.input_ready.wait()
                    if self.overflown and tail:
                        self.send("drop", reason="generated-tail-after-discontinuity", frames=tail,
                                  frameId=batch[-1].meta["frameId"])
                        enhanced = enhanced[:condition_count]
                    else:
                        batch.extend(self.pending.popleft() for _ in range(tail))
                    if self.reference:
                        if fresh and all(row.meta["simTick"] == self.reference.tick for row in batch):
                            enhanced = [self.reference_pixels] * len(batch)
                        if not fresh or len(batch) > 1 or first.meta["simTick"] == self.reference.tick:
                            self.last_render = batch[-1].meta["simTick"], enhanced[-1]
                elif self.regen:
                    enhanced, stats = await self.infer(first.pixels[None])
                else:
                    enhanced = [first.pixels]
                processing_ms = (time.monotonic()-begin)*1000
                await self.output_clear.wait()
                if self.closed:
                    return
                self.output_clear.clear()
                range_start, range_end = first.meta["frameId"], batch[-1].meta["frameId"]
                common = {"chunk": chunk, "range": [range_start, range_end], "fresh": fresh,
                          "adapterMs": processing_ms, "reference": anchor_kind,
                          "signalCue": signal if not self.reference and signal in self.appearance.signal_prompts
                          else None, **stats}
                if self.reference:
                    common["referenceSha256"] = self.reference.digest
                for i, (source, pixels) in enumerate(zip(batch, enhanced, strict=True)):
                    if fresh and self.reference and i < 4 and first.meta["simTick"] != self.reference.tick:
                        continue  # The stamped opening and its interpolation belong to the earlier camera.
                    mapping = "conditioned" if self.regen else "source" if not self.worker_mode else (
                        "held" if held else anchor_kind if fresh and i == 0 else
                        "conditioned" if i % 4 == 0 else "generated-between")
                    self.playback.put_nowait((source, pixels, {**common, "mapping": mapping,
                        "queueMs": max(0, (begin - source.received_at) * 1000)}))
                if self.playback.empty():
                    self.output_clear.set()
                fresh = False
                chunk += 1
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Eden worker %s failed for %s", self.worker.gpu, self.key)
            self.send("failure", reason="GPU 推理异常")
            await self.close("worker-error", broken=True)

    async def expire(self):
        while not self.closed:
            await asyncio.sleep(1)
            if time.monotonic() - self.last_input > 10:
                await self.close("input-timeout")

    async def close(self, reason, broken=False):
        if self.closed:
            return
        self.closed = True
        current = asyncio.current_task()
        jobs = self.jobs - {current}
        for job in jobs:
            job.cancel()
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)
        self.track.stop()
        for track in self.tracks:
            track.stop()
        while not self.playback.empty():
            self.playback.get_nowait()
        self.playback.put_nowait(None)
        if self.peer is not None:
            await self.peer.close()
        if self.socket is not None and not self.socket.closed:
            await self.socket.close()
        if self.inflight is not None:
            try:
                await self.inflight
            except Exception:
                broken = True
        self.pending.clear()
        self.meta.clear()
        self.unmatched.clear()
        log("session-close", sessionId=self.key, epoch=self.epoch, reason=reason,
            received=self.source_count, gpu=self.worker.gpu)
        await self.release(self, broken)
