"""Ada inference kernels for the resident EdenLive transformer."""
import torch
from torch import nn
import triton
from triton import language as tl


@triton.jit
def quantize_rows(source, target, scales, columns: tl.constexpr, tile: tl.constexpr):
    row = tl.program_id(0)
    offsets = tl.arange(0, tile)
    address = row * columns + offsets
    values = tl.load(source + address, offsets < columns, other=0).to(tl.float32)
    scale = tl.maximum(tl.max(tl.abs(values), 0) / 448., 1.e-12)
    tl.store(scales + row, scale)
    tl.store(target + address, tl.clamp(values / scale, -448., 448.), offsets < columns)


def quantize(value):
    value = value.contiguous()
    rows, columns = value.shape
    target = torch.empty_like(value, dtype=torch.float8_e4m3fn)
    scale = torch.empty((rows, 1), dtype=torch.float32, device=value.device)
    quantize_rows[(rows,)](value, target, scale, columns, triton.next_power_of_2(columns))
    return target, scale


class FP8Linear(nn.Module):
    def __init__(self, module):
        super().__init__()
        weight, scale = quantize(module.weight.detach())
        self.register_buffer("weight_fp8", weight.T)
        self.register_buffer("scale", scale.T.contiguous())
        self.register_buffer("bias", None if module.bias is None else module.bias.detach())

    def forward(self, inputs):
        columns = inputs.shape[-1]
        values, scale = quantize(inputs.reshape(-1, columns))
        output = torch._scaled_mm(values, self.weight_fp8, scale, self.scale,
                                  out_dtype=inputs.dtype, use_fast_accum=True)
        if self.bias is not None:
            output = output + self.bias
        return output.reshape(*inputs.shape[:-1], self.weight_fp8.shape[1])


def install_fp8(network):
    # The large attention/FFN projections account for most matmul time.
    # Embeddings, normalization, image conditioning, and output stay BF16.
    for block in network.blocks:
        for parent in block.modules():
            for name, module in list(parent.named_children()):
                if (type(module) is nn.Linear and min(module.in_features, module.out_features) >= 2048
                        and module.in_features % 16 == module.out_features % 16 == 0):
                    setattr(parent, name, FP8Linear(module))


def install_sage(network):
    from flashdreams.core.attention.native import NativeAttention
    from sageattention import sageattn_qk_int8_pv_fp8_cuda

    def adapt(native):
        def attention(query, key, value):
            if query.shape[-1] != 128 or key.shape[-2] < 1024:
                return native(query, key, value)
            return sageattn_qk_int8_pv_fp8_cuda(query, key, value, tensor_layout="HND",
                                                qk_quant_gran="per_thread", pv_accum_dtype="fp32+fp16")
        return attention

    for module in network.modules():
        if isinstance(module, NativeAttention):
            module._impl = adapt(module._impl)
