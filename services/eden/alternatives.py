"""Installed layout-conditioned models shared by the live adapter and benchmarks."""
from contextlib import ExitStack
import sys
from unittest.mock import patch

import numpy as np
import torch


class EdgeTurbo:
    def __init__(self, runtime):
        from diffusers import AutoencoderKL, DDPMScheduler, UNet2DConditionModel
        from transformers import AutoTokenizer, CLIPTextModel

        sys.path.insert(0, str(runtime / "img2img-turbo/src"))
        from pix2pix_turbo import Pix2Pix_Turbo

        assets = runtime / "models/edge-turbo"

        def local_weight(original, variant):
            def load(name, *args, **kwargs):
                if name == "stabilityai/sd-turbo":
                    name = str(assets / "base")
                    kwargs["local_files_only"] = True
                    if variant:
                        kwargs["variant"] = "fp16"
                return original(name, *args, **kwargs)
            return load

        with ExitStack() as aliases:
            for cls, variant in ((AutoencoderKL, True), (UNet2DConditionModel, True), (CLIPTextModel, True),
                                 (AutoTokenizer, False), (DDPMScheduler, False)):
                aliases.enter_context(patch.object(cls, "from_pretrained", local_weight(cls.from_pretrained, variant)))
            self.model = Pix2Pix_Turbo(pretrained_path=str(assets / "edge.pkl")).eval().half()
        self.model.set_eval()

    def render(self, rgb, labels, style, seed):
        import cv2

        edges = cv2.Canny(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), 100, 200)
        if labels is not None:
            boundaries = np.zeros(edges.shape, bool)
            boundaries[1:] |= labels[1:] != labels[:-1]
            boundaries[:, 1:] |= labels[:, 1:] != labels[:, :-1]
            edges[boundaries] = 255
        control = torch.as_tensor(edges, device="cuda")[None, None].expand(-1, 3, -1, -1).half() / 255
        torch.cuda.manual_seed(seed)
        return self.model(control, prompt=style)[0].permute(1, 2, 0) * .5 + .5


class Sharp:
    def __init__(self, runtime):
        sys.path.insert(0, str(runtime / "ml-sharp/src"))
        from sharp.cli.predict import predict_image
        from sharp.models import PredictorParams, create_predictor
        from sharp.utils.gsplat import GSplatRenderer

        self.predict_image = predict_image
        self.predictor = create_predictor(PredictorParams())
        state = torch.load(runtime / "models/sharp/sharp.pt", map_location="cpu", weights_only=True)
        self.predictor.load_state_dict(state)
        self.predictor.eval().cuda()
        self.rasterizer = GSplatRenderer(color_space="linearRGB").cuda().eval()

    def predict(self, rgb, calibration):
        splats = self.predict_image(self.predictor, rgb, calibration["intrinsics"][0][0], torch.device("cuda"))
        return splats, np.linalg.inv(calibration["worldToCamera"])

    def render(self, scene, calibration, width, height):
        splats, anchor_to_world = scene
        view = np.asarray(calibration["worldToCamera"]) @ anchor_to_world
        view = torch.as_tensor(view, dtype=torch.float32, device="cuda")[None]
        intrinsics = torch.tensor(calibration["intrinsics"], device="cuda")[None]
        result = self.rasterizer(splats, view, intrinsics, width, height)
        return result.color[0].permute(1, 2, 0), result.alpha[0, 0] >= .9


def sharp_composite(pixels, covered, labels, current):
    moving_or_signal = np.isin(labels, [0, 19, 24, 25, 26, 27, 28, 31, 32, 33])
    keep = covered & ~torch.as_tensor(moving_or_signal, device="cuda")
    return torch.where(keep[..., None], pixels, current)
