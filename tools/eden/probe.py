"""Record the four CUDA devices and test native Ada BF16 attention."""
import argparse
import json
from pathlib import Path
import subprocess
import time

import torch
from torch.nn.attention import SDPBackend, sdpa_kernel


def probe_device(index):
    torch.cuda.set_device(index)
    info = torch.cuda.get_device_properties(index)
    device = {"gpu":index,"device":info.name,"memoryMiB":info.total_memory//1048576,
              "computeCapability":list(torch.cuda.get_device_capability(index)),
              "bf16":torch.cuda.is_bf16_supported(including_emulation=False),"tests":[]}
    for tokens in (220, 880):
        # Three query frames and up to 18 cached/sink frames in the 5B DiT.
        queries = torch.randn((1, 24, 3*tokens, 128), device="cuda", dtype=torch.bfloat16)
        keys = torch.randn((1, 24, 18*tokens, 128), device="cuda", dtype=torch.bfloat16)
        values = torch.randn_like(keys)
        for backend in (SDPBackend.CUDNN_ATTENTION, SDPBackend.FLASH_ATTENTION):
            test = {"backend":str(backend),"tokens":tokens}
            try:
                with sdpa_kernel(backend):
                    torch.nn.functional.scaled_dot_product_attention(queries, keys, values)
                    torch.cuda.synchronize()
                    begin = time.perf_counter()
                    for _ in range(8):
                        out = torch.nn.functional.scaled_dot_product_attention(queries, keys, values)
                    torch.cuda.synchronize()
                    test["ms"] = (time.perf_counter()-begin)*125
                    test["finite"] = bool(torch.isfinite(out).all())
            except RuntimeError as error:
                test["error"] = str(error)
            device["tests"].append(test)
    return device


def main(output):
    output.mkdir(parents=True, exist_ok=True)
    for file, args in (
        ("gpu-list.txt", ["-L"]),
        ("gpus.csv", ["--query-gpu=index,uuid,name,memory.total,driver_version", "--format=csv"]),
        ("topology.txt", ["topo","-m"]),
    ):
        result = subprocess.check_output(["nvidia-smi",*args], text=True)
        (output/file).write_text(result)
    report = {"torch":torch.__version__,"cudaRuntime":torch.version.cuda,"cudnn":torch.backends.cudnn.version(),
              "devices":[probe_device(index) for index in range(torch.cuda.device_count())]}
    (output/"ada-sdpa.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output",type=Path,required=True)
    main(parser.parse_args().output)
