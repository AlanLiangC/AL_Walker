"""Create aligned source/output comparisons from saved EdenLive runs."""
import argparse
from pathlib import Path
import subprocess

from imageio_ffmpeg import get_ffmpeg_exe


def ffmpeg(inputs, filters, output, *options):
    command = [get_ffmpeg_exe(), "-nostdin", "-hide_banner", "-loglevel", "error", "-y"]
    for path in inputs:
        command.extend(["-i", str(path)])
    subprocess.run([*command, "-filter_complex_threads", "2", "-filter_complex", filters,
                    *options, str(output)], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--frames", type=int, nargs="+", default=[0, 32, 120, 392, 408, 468])
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, help="Fit each view into this height to compare different aspect ratios")
    parser.add_argument("--video", action="store_true")
    parser.add_argument("inputs", type=Path, nargs="+")
    args = parser.parse_args()
    if len(args.inputs) < 2:
        parser.error("Provide at least two videos")
    args.output.mkdir(parents=True, exist_ok=True)
    size = f"{args.width}:-2:flags=lanczos"
    if args.height:
        size = (f"{args.width}:{args.height}:flags=lanczos:force_original_aspect_ratio=decrease:"
                f"force_divisible_by=2,pad={args.width}:{args.height}:(ow-iw)/2:(oh-ih)/2")
    n = len(args.inputs)
    stack = "".join(f"[v{i}]" for i in range(n)) + f"hstack=inputs={n}:shortest=1"
    scale = [f"[{i}:v]scale={size}[v{i}]" for i in range(n)]
    if args.video:
        ffmpeg(args.inputs, ";".join([*scale, stack]), args.output / "comparison.mp4",
               "-an", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "fast", "-movflags", "+faststart")
    for frame in args.frames:
        select = [f"[{i}:v]select=eq(n\\,{frame}),setpts=PTS-STARTPTS,scale={size}[v{i}]" for i in range(n)]
        ffmpeg(args.inputs, ";".join([*select, stack]), args.output / f"frame-{frame:03d}.png", "-frames:v", "1")


if __name__ == "__main__":
    main()
