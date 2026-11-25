"""WebRTC admission, bounded buffering and frame provenance for CityNav."""
from collections import OrderedDict, deque
from fractions import Fraction
import asyncio
import json
import logging
import math
import time

from aiortc import MediaStreamTrack, RTCConfiguration, RTCIceServer, RTCPeerConnection
from aiortc.mediastreams import MediaStreamError
import numpy as np

from .rtc.frames import InputFrame, pack, read_input
from .worker import generate

logger = logging.getLogger("citynav.eden")
CLOCK = 90_000


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

    async def recv(self):
        row = await self.session.playback.get()
        if row is None:
            raise MediaStreamError
        source, enhanced, meta = row
        now = time.monotonic()
        if self.session.worker_mode:
            captured = source.meta["capturedAt"] / 1000
            interval = 1 / self.session.profile["fps"]
            new_rollout = meta["fresh"] and source.meta["frameId"] == meta["range"][0]
            if self.time_offset is None or (new_rollout and abs(now - (self.time_offset + captured)) > 2 * interval):
                self.time_offset = now - captured
            target = max(self.time_offset + captured, self.last_at + interval / 3)
            await asyncio.sleep(max(0, target - now))
        if self.session.closed:
            raise MediaStreamError
        if self.session.output_id >= 0xFFFFFF:
            raise MediaStreamError
        self.last_at = time.monotonic()
        base = self.session.opened
        self.pts = max(self.pts + 1, round((self.last_at - base) * CLOCK))
        output_id = self.session.output_id
        self.session.output_id += 1
        start = time.monotonic()
        frame = pack(source.pixels, enhanced, output_id)
        frame.pts = self.pts
        frame.time_base = Fraction(1, CLOCK)
        self.session.send("output", outputId=output_id, frameId=source.meta["frameId"],
                          simTick=source.meta["simTick"], inputPts=source.pts, outputPts=self.pts,
                          serverAgeMs=(self.last_at-source.received_at)*1000,
                          packingMs=(time.monotonic()-start)*1000, **meta)
        if self.session.playback.empty():
            self.session.output_clear.set()
        return frame


class Session:
    def __init__(self, key, epoch, context, worker, profile, release, references, ice_servers, appearance):
        self.key, self.epoch, self.context = key, epoch, context
        self.worker, self.profile, self.release = worker, profile, release
        self.references = references
        self.appearance = appearance
        self.peer = RTCPeerConnection(RTCConfiguration(iceServers=[RTCIceServer(**item) for item in ice_servers]))
        self.width, self.height = profile["width"], profile["height"]
        self.worker_mode = profile["backend"] == "edenlive"
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

        self.track = PairedVideo(self)

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.jobs.add(task)
        task.add_done_callback(self.jobs.discard)

    def start(self):
        self.spawn(self.process())
        self.spawn(self.expire())
        log("session-open", sessionId=self.key, epoch=self.epoch, gpu=self.worker.gpu,
            prompt=self.prompt if self.worker_mode else None, **self.context)

    def send(self, kind, **values):
        data = {"type": kind, "sessionId": self.key, "epoch": self.epoch, **values}
        channel = self.channel
        if channel and channel.readyState == "open" and channel.bufferedAmount < 256_000:
            channel.send(json.dumps(data, separators=(",", ":")))
        if kind in ("output", "drop", "failure"):
            log(kind, gpu=self.worker.gpu, **data)

    def input_meta(self, raw):
        if self.closed or not isinstance(raw, str) or len(raw) > 4096:
            return
        try:
            value = json.loads(raw)
            if not isinstance(value, dict):
                return
            frame_id, tick, captured = value["frameId"], value["simTick"], value["capturedAt"]
            if (value.get("type") != "input" or value.get("sessionId") != self.key
                    or value.get("epoch") != self.epoch or type(frame_id) is not int
                    or not self.last_frame_id < frame_id <= 0xFFFFFF or type(tick) is not int
                    or not 0 <= tick <= 10_000_000 or type(captured) not in (float, int)
                    or not math.isfinite(captured)):
                return
        except (ValueError, KeyError):
            return
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
        self.last_frame_id = frame_id
        self.last_input = received
        # The 16-line tag is removed before any conditioning or reference encoding.
        image = np.ascontiguousarray(frame.to_ndarray(format="rgb24")[: self.height])
        limit = 12 if self.worker_mode else 1
        if len(self.pending) == limit:
            skipped = self.pending.popleft()
            self.send("drop", frameId=skipped.meta["frameId"], reason="input-backpressure")
            self.overflown = True
        self.pending.append(InputFrame(values, image, frame.pts, received))
        self.input_ready.set()

    async def process(self):
        fresh = True
        chunk = 0
        try:
            while not self.closed:
                count = (9 if fresh or self.overflown else 12) if self.worker_mode else 1
                condition_count = 9 if self.worker_mode else 1
                if len(self.pending) < condition_count:
                    self.input_ready.clear()
                    await self.input_ready.wait()
                    continue
                reset_history = self.overflown and not fresh
                fresh = fresh or self.overflown
                self.overflown = False
                if reset_history and self.worker_mode:
                    log("history-resync", sessionId=self.key, epoch=self.epoch, gpu=self.worker.gpu)
                batch = [self.pending.popleft() for _ in range(condition_count)]
                begin = time.monotonic()
                first = batch[0]
                stats = {"workerMs": 0}
                anchor_kind = "source"
                signal = first.meta.get("signalState")
                if signal not in ("stop", "walk", "yield", "full-stop"):
                    signal = None
                if self.worker_mode:
                    target = None
                    if fresh:
                        target = first.pixels
                        for pixels, camera, tick in self.references:
                            if first.meta["simTick"] == tick and aligned_camera(camera, first.meta.get("camera")):
                                target = pixels
                                anchor_kind = "reference"
                                break
                    condition = np.stack([source.pixels for source in batch[::4]])
                    prompt = self.appearance.prompt(self.context["weather"], signal)
                    self.inflight = asyncio.create_task(self.worker.run(
                        generate, condition, target, prompt, self.context["seed"],
                    ))
                    try:
                        enhanced, stats = await asyncio.wait_for(
                            asyncio.shield(self.inflight), timeout=self.profile.get("inferenceTimeoutMs", 30_000)/1000)
                    except TimeoutError:
                        self.worker.abort()
                        raise
                    self.inflight = None
                    tail = count-condition_count
                    # The fourth-spaced controls are complete at frame 8.
                    # Frames 9–11 can arrive during inference and pair with the
                    # synthesized tail. A discontinuity invalidates that tail.
                    while len(self.pending) < tail and not self.overflown:
                        self.input_ready.clear()
                        await self.input_ready.wait()
                    if self.overflown and tail:
                        self.send("drop", reason="generated-tail-after-discontinuity", frames=tail,
                                  frameId=batch[-1].meta["frameId"])
                        enhanced = enhanced[:condition_count]
                    else:
                        batch.extend(self.pending.popleft() for _ in range(tail))
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
                          "signalCue": signal if signal in self.appearance.signal_prompts else None, **stats}
                for i, (source, pixels) in enumerate(zip(batch, enhanced, strict=True)):
                    mapping = "source" if not self.worker_mode else (
                        anchor_kind if fresh and i == 0 else "conditioned" if i % 4 == 0 else "generated-between")
                    self.playback.put_nowait((source, pixels, {**common, "mapping": mapping,
                        "queueMs": max(0, (begin - source.received_at) * 1000)}))
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
        await self.peer.close()
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
