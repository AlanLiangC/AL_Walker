"""User-supplied appearance and optional spatially matched opening images."""
from dataclasses import dataclass, field
import json
from pathlib import Path

from PIL import Image
import numpy as np

PROMPT = (
    "Photorealistic outdoor footage, natural exposure, realistic asphalt and concrete surfaces, "
    "natural facade and vegetation textures, color-neutral lighting."
)
WEATHER = {
    "day": "Natural daylight.",
    "wet": "Overcast daylight on wet pavement.",
    "rain": "Rain and wet pavement under overcast daylight.",
    "night": "Nighttime street lighting and wet road reflections.",
    "snow": "Falling snow and snow-covered surfaces.",
    "fog": "Dense fog, low contrast in the distance.",
}


@dataclass(frozen=True)
class Appearance:
    static_prompt: str = PROMPT
    weather: dict = field(default_factory=lambda: WEATHER.copy())
    signal_prompts: dict = field(default_factory=dict)
    episode_id: str | None = None
    robot_id: str | None = None
    camera_mode: str | None = None
    anchors: tuple = ()

    @classmethod
    def load(cls, path: Path | None):
        if path is None:
            return cls()
        data = json.loads(path.read_text())
        prompt = data["staticPrompt"]
        weather = data.get("weatherPrompts", {})
        signals = data.get("signalPrompts", {})
        if not isinstance(prompt, str) or not prompt.strip() or any(
            not isinstance(mapping, dict) for mapping in (weather, signals)
        ) or any(
            not isinstance(key, str) or not isinstance(value, str)
            for mapping in (weather, signals) for key, value in mapping.items()
        ):
            raise ValueError(f"Invalid style prompt in {path}")
        anchors = []
        for filename in data.get("references", []):
            manifest = path.parent / filename
            anchor = json.loads(manifest.read_text())
            anchors.append({**anchor, "image": manifest.parent / anchor["image"]})
        return cls(static_prompt=prompt.strip(), weather=weather, signal_prompts=signals,
                   episode_id=data.get("episodeId"), robot_id=data.get("robotId"),
                   camera_mode=data.get("cameraMode"), anchors=tuple(anchors))

    def for_context(self, context):
        if (self.episode_id in (None, context["episodeId"])
                and self.robot_id in (None, context.get("robotId"))
                and self.camera_mode in (None, context.get("cameraMode"))):
            return self
        return Appearance()

    def prompt(self, weather=None, signal=None):
        terms = (self.static_prompt, self.weather.get(weather), self.signal_prompts.get(signal))
        return " ".join(term for term in terms if term)

    def references_for(self, context, width, height):
        for anchor in self.anchors:
            if any(anchor[key] != context[key] for key in ("episodeId", "seed", "cameraMode", "weather")):
                continue
            if anchor.get("robotId") != context.get("robotId"):
                continue
            with Image.open(anchor["image"]) as image:
                if image.width * height != image.height * width:
                    raise ValueError(f"Reference {anchor['image']} must have aspect ratio {width}:{height}")
                pixels = np.array(image.convert("RGB").resize((width, height), Image.Resampling.LANCZOS))
            yield pixels, anchor["camera"], anchor["simTick"]
