"""Fixed-look REGEN inference for CityNav captures."""
from pathlib import Path
import sys


class Regen:
    def __init__(self, profile, source, weights):
        import torch

        self.profile, self.torch = profile, torch
        self.width, self.height, self.latent_chunk = profile["width"], profile["height"], 1
        sys.path.insert(0, str(Path(source)))
        from generator import define_G

        model = define_G(input_nc=3, output_nc=3, ngf=64, netG="global", norm="instance",
                         n_downsample_global=4, n_blocks_global=9, n_local_enhancers=0)
        state = torch.load(weights, map_location="cpu", weights_only=True)
        model.load_state_dict(state.get("state_dict", state))
        self.model = model.eval().cuda().half().to(memory_format=torch.channels_last)

    def pixels(self, rgb):
        t = self.torch
        with t.inference_mode():
            source = t.as_tensor(rgb, device="cuda").permute(2, 0, 1)[None].half().contiguous(
                memory_format=t.channels_last)
            return self.model(source * (2 / 255) - 1)[0].permute(1, 2, 0) * .5 + .5

    def generate(self, condition, _anchor, _prompt, _seed):
        output = (self.pixels(condition[0]).clamp(0, 1)*255).round().byte().cpu().numpy()
        return [output], {}

    def reset(self):
        pass
