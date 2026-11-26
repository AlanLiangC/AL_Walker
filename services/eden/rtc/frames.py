"""Frame IDs in the transport margin bind pixels to reliable side-channel metadata."""
from dataclasses import dataclass

import av
import numpy as np

MARGIN = 16
CELL = 8
MAGIC = 0xA7


def checksum(data):
    crc = 0
    for byte in data:
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ (7 if crc & 128 else 0)) & 255
    return crc


def read_input(frame, width, height):
    if (frame.width, frame.height) != (width, height + MARGIN):
        return None, "resolution"
    plane = frame.reformat(format="yuv420p").planes[0]
    y = np.frombuffer(plane, np.uint8).reshape(-1, plane.line_size)
    values = y[height + MARGIN // 2, CELL // 2 : 40 * CELL : CELL]
    if np.any((values > 80) & (values < 175)):
        return None, "unreadable-tag"
    tag = np.packbits(values >= 175).tobytes()
    if tag[0] != MAGIC or tag[4] != checksum(tag[:4]):
        return None, "unreadable-tag"
    return int.from_bytes(tag[1:4], "big"), None


def pack(draft, main, output_id):
    height, width, _ = main.shape
    image = np.empty((height + MARGIN, width if draft is None else width * 2, 3), np.uint8)
    if draft is not None:
        image[:height, :width] = draft
    image[:height, -width:] = main
    image[height:] = 16
    tag = bytes((MAGIC,)) + output_id.to_bytes(3, "big")
    bits = np.unpackbits(np.frombuffer(tag + bytes((checksum(tag),)), np.uint8))
    span = 40 * CELL
    for offset in range(0, image.shape[1]-span+1, span):
        polarity = (offset // span) % 2
        image[height:, offset:offset+span] = np.repeat(
            np.where(bits ^ polarity, 235, 16), CELL
        )[None, :, None]
    return av.VideoFrame.from_ndarray(image, format="rgb24")


@dataclass
class InputFrame:
    meta: dict
    pixels: np.ndarray
    pts: int
    received_at: float
