"""Bridge the compatible Wan 2.2 normalized latents to LightTAE."""
from pathlib import Path
import sys


def install_lighttae(weights, eden_source):
    for folder in ("realtime/flashdreams", "realtime/integrations_v2"):
        sys.path.insert(0, str(Path(eden_source) / folder))
    from flashdreams.recipes.taehv import TeahvVAEWan22DecoderConfig
    from vllm_omni.diffusion.models.cosmos3_nano_sim_bimanual import Cosmos3NanoSimTransferPipeline

    def decode(pipeline, state, latents):
        if not hasattr(pipeline, "_citynav_decoder"):
            config = TeahvVAEWan22DecoderConfig(checkpoint_path=weights, dtype=pipeline.dtype,
                                                 use_cuda_graph=False, use_compile=False)
            pipeline._citynav_decoder = config.setup().to(pipeline.device).eval()
        decoder = pipeline._citynav_decoder
        if getattr(pipeline, "_citynav_decode_state", None) is not state:
            pipeline._citynav_decode_state = state
            pipeline._citynav_decode_cache = decoder.initialize_autoregressive_cache()
        video = decoder(latents.permute(0, 2, 1, 3, 4).contiguous(), cache=pipeline._citynav_decode_cache)
        state.record_incremental_decode(input_frames=int(latents.shape[2]))
        return video.permute(0, 2, 1, 3, 4).contiguous()

    Cosmos3NanoSimTransferPipeline._decode_live_latents = decode
