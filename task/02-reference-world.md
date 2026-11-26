# CityNav 参考帧驱动的写实闭环

持续驾驶和需要低延迟 RGB 的导航器使用 [连续写实闭环](02-realtime.md)。本页的计时和接口对应逐步生成模式。

在任务面板选择任务，切到机器人或追踪视角，点击「写实闭环 → Cosmos3 · 深度写实」。选择预设场景风格或输入自己的提示词，再点「生成参考帧」。画面出现后即可开始键盘驾驶。刷新任务、更换机器人或相机视角会清除当前参考帧。可以随时切回 CityNav 原画。其他逐步模型在 `renderBench=1` 的实验入口中选择。

EdenLive 和 SolarRenderer 使用 Qwen-Image 2.1 生成开局图，并以首帧和 CityNav RGB 结构帧续渲染。Cosmos3 使用当前深度和用户风格生成开局图，并保留开局与后续生成历史。CityNav 负责运动、碰撞、交通、信号灯和传感器，物理天气参数也在 CityNav 中设置。动作处理后返回一帧带仿真步号的 RGB。会话通过首帧 SHA256 校验参考图身份。生成模型对车辆外形、灯色和遮挡的再现需要逐段画面验收。

## 启动

以下命令在项目根目录运行。已有环境可从启动命令开始。`prepare-generative.sh qwen-image` 准备编辑器依赖，启动时自动查找公共 Qwen 权重。该运行器还使用项目自带的 Blender 运行目录，安装位置见 [视觉闭环准备说明](02-rendered-loop.md)。

```bash
bash tools/eden/prepare.sh all
bash tools/visual/prepare-generative.sh qwen-image
bash tools/world/prepare.sh --download
bash tools/visual/run.sh --reference-editor-gpu 0 --reference-render-gpu 1
```

浏览器访问 `http://127.0.0.1:8771/src/?eden=/eden&episode=office-09-x05&view=robot`。SolarRenderer 的两张卡通过 `CITYNAV_SOLAR_GPUS` 设置，默认 `2,3`。`CITYNAV_PUBLIC_MODELS` 默认指向 `/inspire/hdd/global_public/public_models`。本地代码、模型补片、覆盖依赖和会话写入 `.eden/world`。迁移后，SolarRenderer 会把本地模块索引定位到新项目路径。公共权重挂载点变化时，运行 `bash tools/world/prepare.sh` 重建引用。缺失的 H3 部件可用 `--download` 补齐。Qwen-Image 2.1 也可放在项目的 `.eden/models/visual/qwen-image-21`。

## 外接导航器

以下接口运行在 CityNav 页面中。`image` 是 PNG Blob，`observation` 携带同一时刻的 CityNav 状态。`observationId` 用于提交基于该帧的动作。渲染请求失败时，可以用 `observe()` 重取当前状态，避免重复执行动作。

```js
CityNav.policy.reset({episodeId: 'office-09-x05', robotId: 'go2'});
let frame = await CityNav.rendered.start({
  method: 'cosmos',
  style: 'Photoreal street photography after rain, with wet asphalt and overcast daylight.',
  styleSeed: 42,
});
frame = await CityNav.rendered.step({throttle: 0.5, turn: 0.15}, {
  observationId: frame.observationId,
  ticks: 2,
});
```

## 模型与验证

| 模型 | CityNav 接法 | 验证 |
| --- | --- | --- |
| EdenLive 5B 720p | 每个会话保留首帧和时序状态，取与最新结构帧对齐的输出。 | 网页键盘和导航器已实跑。外部步骤 `0 → 2 → 4` 的参考帧 SHA256 一致，RGB 各步不同。热机续帧约 3.38–3.59 秒。首次键盘续帧含加载约 83 秒。 |
| Cosmos3-Nano-Sim-Transfer | CityNav 按相同机位提供可见表面的深度，模型保留因果生成历史，返回当前状态的新图像。 | 832×480，同会话三个连续深度请求分别用时 641、648、656 ms。 [逐步生成实测](../.eden/results/realtime/cosmos-ticks/metrics.json) |
| SolarRenderer | MiniMax-H3 Ref2VA 与官方四步因果 LoRA。每次动作使用已经取得的 CityNav 状态生成一个 22 帧短片，取末帧。 | 两张 48 GiB Ada 卡完成 1344×768 原生短片。编码 104.53 秒，加载、生成与解码 121.02 秒。该适配器按动作重建短片上下文。 |
| Code World Model 2.0 | Invoker-Render 原生文件客户端用固定系统提示词和用户首帧，校验输出帧数、EOS 和关闭回执。 | 公共目录缺两个生成权重分片、配置和索引。本机有四张 48 GiB Ada 卡，官方生产配置是单节点八卡。实机验证还需要匹配发布权重的 encoder、frozen artifact、causal decoder 和静音张量。 |
| Blender Cycles | CityNav 状态驱动的离线光线追踪对照。 | 基准见 [Cycles 渲染记录](02-rendered-loop.md)。 |

默认 EdenLive 使用完整 WanVAE。启动时设置 `CITYNAV_REFERENCE_EDEN_PROFILE=ada-720p` 可使用 LightTAE。同一任务测试的热机续帧为 1.60–1.92 秒，车辆和远处灯罩边缘略有模糊。 [LightTAE 画面](../.eden/results/world/eden-reference-lighttae/external-04.png) · [闭环记录](../.eden/results/world/eden-reference-lighttae/results.json)

SolarRenderer 测试使用本项目真实采集的机器人原画和用户风格参考帧。在两个 Ada GPU 上分布文本编码器和生成模型，使用 PyTorch SDPA、逐段执行 FFN，并在采样结束后将 VAE 放上 GPU。22 帧是缩短的 VAE 对齐窗口，原生短片时间轴为 24 FPS。实拍风格可见于湿地与车身反光，灯罩仍接近代理形状。三联图从左至右为动作后 CityNav 原画、开局参考帧和动作后 SolarRenderer 输出。网页键盘验证了 `0 → 2`，从提交动作后的结构帧到生成 1344×768 的续帧约 183 秒。 [三联图](../.eden/results/world/solar/comparison.png) · [原生视频](../.eden/results/world/solar/video.mp4) · [网页键盘截图](../.eden/results/world/solar-browser/keyboard.png) · [浏览器计时](../.eden/results/world/solar-browser/results.json)

来源见 [SolarRenderer 原生实现](https://github.com/Enderfga/SolarRenderer/tree/0ca4f5e45b062cc9e9aee506de46aabdc22e4c3d)、[SolarRenderer 推理与权重](https://huggingface.co/Enderfga/SolarRenderer)、[Code World Model 2.0 部署规格](https://github.com/inclusionAI/CodeWorldModel/blob/88fc349a260b691214e932cb37f6a080e07fb1ff/docs/INFERENCE.md)。

已部署 Invoker-Render 时，把 `CITYNAV_INVOKER_BUNDLE`、`CITYNAV_INVOKER_ARTIFACT`、`CITYNAV_INVOKER_PYTHON` 和 `CITYNAV_INVOKER_WS` 指向同一部署的项目内 bundle、artifact、Python 环境和原生 WebSocket。系统提示词直接读取 artifact。公共目录只有生成权重的一部分，需要按上游说明打包各组件。 [官方权重](https://huggingface.co/inclusionAI/invoker-render-1.0) · [原生推理命令](https://raw.githubusercontent.com/inclusionAI/CodeWorldModel/88fc349a260b691214e932cb37f6a080e07fb1ff/docs/INFERENCE.md)

## Cosmos3 深度写实

网页使用「Cosmos3 · 深度写实」。导航器沿用上面的 `start()` 和 `step()`，将 `method` 设为 `'cosmos'`。渲染器等动作提交后读取该仿真步的城市深度，返回 832×480 PNG。每个工作进程保留一个会话，重新生成参考帧会开启新的会话。`CITYNAV_COSMOS_GPU` 指定推理卡。

单张 4090 热机时，键盘读取两次实际动作后的画面，采集到呈现均约 1.03 秒。GPU 加速的浏览器采集约 29–33 ms，服务端分别耗时 814 和 817 ms。换任务后，测试导航器读取两张 PNG，分别选了右转和左转，收到不同的图像以及配对的 tick 0、2、4，首帧 SHA256 保持一致。热机生成参考帧后约 1.6 秒显示，模型首次加载后的整段等待约 104 秒。 [浏览器热机数据](../.eden/results/realtime/cosmos-web-hw/results.json) · [首次加载数据](../.eden/results/realtime/cosmos-web/results.json)

原画并排入口同时适用于 Cosmos3。额外的 20 帧测试包含停等、前进和转向，Go2 在真实仿真中移动了 4.59 m。逐步交互从提交动作到收到 PNG 的中位耗时 1.03 秒。转向后模型把部分铺装替换为草地，并简化了转角建筑的外立面。 [网页并排截图](../.eden/results/realtime/cosmos-parallel-final/keyboard.png) · [同状态录像](../.eden/results/realtime/cosmos-route/same-state-comparison.mp4) · [轨迹数据](../.eden/results/realtime/cosmos-route/results.json)

CityNav 实际采集的近车深度测试中，模型跟着车辆位移生成车体、铺装和遮挡。同一片段使用完整 WanVAE 解码约 2.9 帧每秒，切换到 LightTAE 后约 5.4 帧每秒。明确描述开阔地平线的逐步测试保住了空旷背景。只用深度约束时，部分结果仍会改写车辆类别或补出建筑。 [近车逐步对照](../.eden/results/realtime/cosmos-ticks/comparison.jpg) · [相同输入的解码器画质对照](../.eden/results/realtime/cosmos-codecs/frame-032.png) · [同帧原画、深度和合成](../.eden/results/realtime/cosmos-compare/frame-032.png)

固定车辆轨迹下，320×192、832×480 和 1280×704 热机续帧中位数分别为 257、648 和 1,375 ms。320×192 会模糊车体和灯头。1280×704 能补出轮毂与标线细节，但车身类别与灯态仍可能有偏差。网页选用 832×480。 [三个分辨率的同状态对照](../.eden/results/realtime/cosmos-ticks/resolution-comparison.jpg) · [续帧数据](../.eden/results/realtime/cosmos-ticks/resolution-results.json)

同一组 20 帧另测了低通 RGB 条件。转向后道路和立面更贴近原画，灰天风格和真实材质的重建则减弱，部分镜头出现原画没有的线缆。热机每步中位耗时 760 ms。网页使用深度条件。 [亮度与空间布局对照](../.eden/results/realtime/cosmos-route-blur/control-comparison.jpg) · [低通 RGB 续帧数据](../.eden/results/realtime/cosmos-route-blur/metrics.json)

权重和 CUDA 运行依赖位于 `.eden`。vLLM-Omni 源码固定为 `fb083defd513fa9fb281afdea3764e1ffc2fe511`，逐步适配补丁随仓库保存在 `tools/world/cosmos-ticks.patch`。已有环境迁移时使用 [项目归档命令](02-realtime.md#启动)。 [公开模型](https://huggingface.co/nvidia/Cosmos3-Nano-Sim-Transfer) · [上游推理实现](https://github.com/vllm-project/vllm-omni/pull/10766)

## 画质对照

目标画面是 `streaming-comparison` 第四、第五列中从写实首帧续渲染的 EdenLive 图像，采用追踪视角、阴天湿路和交通事件提示。两列使用 LightTAE 和 WanVAE。新版机器人视角的雨后参考帧已经重建玻璃、车身、轮胎和反光，四次动作后依然保持这些材质，CityNav 实际前进约 1.32 米并先后转向。信号灯外壳和远景仍有简化。第二个导航任务使用暖色干燥街道提示词，个别灯出现红绿同亮，仍需校验。 [目标帧](../.eden/results/quality/streaming-comparison/frame-032.png) · [原对照及信号误差](02-quality.md) · [雨后机器人视角对照](../.eden/results/world/eden-reference-revised/rain-comparison.png) · [雨后第 43 步](../.eden/results/world/eden-reference-revised/extended-43.png) · [暖色任务动作后](../.eden/results/world/eden-reference-revised/external-04.png) · [实测记录](../.eden/results/world/eden-reference-revised/results.json)

```bash
source tools/eden/env.sh
"$EDEN_PY" tools/world/check-browser.py --output "$CITYNAV_EDEN_ROOT/results/world/retest"
```
