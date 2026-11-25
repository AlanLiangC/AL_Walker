"""Write Eden's offline prompt timeline and the live reference manifest."""
import argparse
from itertools import groupby
import json
from pathlib import Path

from services.eden.appearance import Appearance


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("recording", type=Path)
    parser.add_argument("--style", type=Path, help="Defaults to style.json in the recording directory")
    parser.add_argument("--weather", required=True)
    args = parser.parse_args()
    truth = json.loads((args.recording / "truth.json").read_text())
    fps, frames = truth["fps"], truth["frames"]
    first = frames[0]
    save(args.recording / "anchor.json", {
        "episodeId": truth["config"]["episodeId"], "seed": truth["config"]["seed"],
        "robotId": truth["config"]["robotId"],
        "cameraMode": truth["view"], "weather": args.weather, "simTick": first["tick"],
        "camera": first["camera"], "image": "cover.png",
    })
    style = Appearance.load(args.style or args.recording / "style.json")
    events = []
    for state, group in groupby(frames, lambda row: (row["signal"] or {}).get("state")):
        rows = list(group)
        if text := style.signal_prompts.get(state):
            events.append({"startMs": rows[0]["frame"] * 1000 / fps,
                           "endMs": (rows[-1]["frame"] + 1) * 1000 / fps, "text": text})
    save(args.recording / "prompts.json", {
        "durationMs": len(frames) * 1000 / fps, "staticPrompt": style.prompt(args.weather), "dynamicPrompts": events,
    })


if __name__ == "__main__":
    main()
