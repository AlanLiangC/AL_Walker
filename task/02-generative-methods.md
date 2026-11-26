# CityNav 写实闭环的五种生成式渲染方法

打开办公区的机器人第一视角，点「写实闭环」后可选择五种生成方法与 Blender Cycles。原画按钮切回 CityNav WebGL。Cycles 是默认基准。页面按是否找到本地权重显示选项状态。

## 五种方法

| 方法 | 输入和接法 | 画质验证计划 |
| --- | --- | --- |
| **EdenLive 5B** | 复用项目已有的 checkpoint 与 640×352 推理配置。每次从已观测的最近三帧取 RGB 控制，使用当前控制对应的第 9 帧。起点的相机、机型、episode、种子匹配时使用之前校对过的写实首帧。 | 看接近横道时的纹理连续性，并逐帧核对灯色与车辆轮廓。比较生成结果与项目以往的视频增强。 [EdenLive 源码](https://github.com/VAST-AI-Research/EdenLive) |
| **Qwen-Image 2.1** | 读取共享目录中的 7B 图像生成组件及配套图像编码器。用同 tick 的 Cycles RGB 和场景提示词编辑单帧。测试用 28 步，等比缩放到 960×528 后补边推理。 | 对比路面、自然光和背景细节。沿连续视角检查相机几何漂移，尤其是贴近车辆轮廓时的重影。 [Qwen 官方模型](https://huggingface.co/Qwen/Qwen-Image-2.1) |
| **Difix3D+** | 用官方单图 Difix checkpoint 对 Cycles RGB 做一步去伪影，保持输出构图。在 1280×704 运行。 | 检查原有几何边缘和材质细节能否同时保留。项目里的合成街景与论文主要使用的重建数据有差异，实测图像再决定提升幅度。 [NVIDIA 论文与示例](https://research.nvidia.com/labs/toronto-ai/difix3d/) |
| **SDXL Depth ControlNet** | 以 Cycles RGB 为起点，用同相机导出的度量深度约束 img2img。固定深度映射、噪声种子与重绘强度，采样结果回到 1280×704。 | 以斑马线两端、路缘、建筑边缘的位置偏差为主要指标。调重绘强度时同时检查纹理提升和画面抖动。 [Diffusers SDXL ControlNet 接口](https://huggingface.co/docs/diffusers/api/pipelines/controlnet_sdxl) |
| **Wan2.1 VACE 1.3B** | 接入最近五个已观测状态的 RGB 及窗口首帧参考，可切到度量深度。起步时用当前状态填充缺失的历史位置，只返回当前状态对应的最后一帧。复用项目中的 UMT5-XXL。 | 深度模式首轮保留了过多灰度控制外观，因此切到弱约束的 RGB 视频翻译。检查细节、静止背景和连续视角的外观漂移。短窗口是本项目的闭环配置。 [Wan VACE 模型与推理说明](https://huggingface.co/Wan-AI/Wan2.1-VACE-1.3B-diffusers) |

也核对了 Cosmos 3 Sim-Transfer 的深度、语义和边缘输入。它适合做后续的物理仿真转视频对照，本轮五个方法优先使用能在项目中准备的本地权重。 [NVIDIA Cosmos 仿真项目](https://research.nvidia.com/labs/cosmos-lab/cosmos-simulation/)

## 本地实测

五种方法都通过了办公区浏览器的渲染方法核对，以及导航器从第 0 tick 观察并推进到第 2 tick 的测试。固定状态对比使用第 0、335、337 tick。335 与 337 的信号切换前后，每张图的 308 个透镜像素，以及其余车辆、行人和道路标线保护区，与各自的 Cycles 真值逐像素一致。一次从 0 跳到 335 的试验暴露出旧视角的灯影。视频后端现在限制跨 tick 使用历史的范围，复测该路口画面中的旧灯影已消除。 [开局对比](../.eden/results/visual/methods/tick-0/comparison.png) · [红灯对比](../.eden/results/visual/methods/tick-335/comparison.png) · [绿灯对比](../.eden/results/visual/methods/tick-337/comparison.png)

| 方法 | RTX 4090 生成阶段耗时 | 样例观察 |
| --- | ---: | --- |
| EdenLive 5B | 0.90 秒 | 路面、云层与远景改动最明显。640 档的地面细节偏软。 |
| Qwen-Image 2.1 | 9.14 秒 | 路面细节清晰，局部路缘和材质边界仍可能变化。 |
| Difix3D+ | 1.23 秒 | 画面接近 Cycles，主要改善纹理和锐度。 |
| SDXL Depth ControlNet | 1.79 秒 | 有深度约束，部分地砖和路缘仍有轻微形变。 |
| Wan2.1 VACE 1.3B | 13.48 秒 | 当前五帧 RGB 设置外观接近参考。深度输入试验只重建出近似灰度图。 |

耗时是预加载模型后，第 335、337 tick 的生成与合成平均值。交互还包括 Cycles 渲染和浏览器传输。另测了 EdenLive 的 1280×704 WanVAE 档，可在生成配置中将 `profile` 改成 `ada-720p-vae`。该档只完成了开局样帧对照。所有方法保留了 CityNav 交通参与者的原有模型外观，场景整体距离实拍仍有差距。 [EdenLive 高画质样帧](../.eden/results/visual/methods/eden720/tick-0/edenlive.png)

## 同状态约束

CityNav 决定相机、车辆、行人、骑行者和灯相位。Cycles 在同一次渲染输出 RGB、度量深度、物体编号和受保护的标线。生成后合成回当前 tick 的交通参与者、信号灯和交通标线，并保护邻近轮廓。视频方法只使用同一轮已观测的历史状态。保护区域之外仍可能生成额外物体或改变材质，这需要看实测图和连续帧。

客户端校验 UUID、tick 和渲染方法。生成等待或失败期间仿真保持当前位置。外部导航器可指定方法，后续 `step()` 沿用当前观测使用的方法。

```js
CityNav.policy.reset({ episodeId: 'office-09-x05', robotId: 'go2' });
let frame = await CityNav.rendered.observe({ method: 'qwen-image' });
frame = await CityNav.rendered.step({ throttle: .5 }, {
  observationId: frame.observationId,
  ticks: 2,
});
```

## 运行与迁移

```bash
bash tools/visual/prepare-generative.sh
bash tools/visual/run.sh --photo-gpu 3 --photo-model-gpu 0
```

如只准备一种方法，可向准备脚本传 `qwen-image`、`difix`、`sdxl-depth` 或 `wan-vace`。EdenLive 和 Wan VACE 的共享文本编码器沿用已有的项目权重。Qwen 默认只读共享目录。迁移时可用 `CITYNAV_PUBLIC_MODELS` 指向目标机的共享目录，或把完整 Qwen 快照放入 `.eden/models/visual/qwen-image-21`。新依赖与其余模型均保存在项目的 `.eden` 目录。

场景提示词、参考图路径、步数和 seed 可在项目内修改。相同状态的 RGB 和 EXR 可通过 `tools/visual/compare-methods.py --capture` 导出。加 `--method` 可运行一个生成后端并比较像素。加 `--montage` 可把同状态图像排成带标签的对照图。 [生成配置](../assets/visual/generative.json) · [对比工具](../tools/visual/compare-methods.py) · [闭环使用](02-rendered-loop.md)
