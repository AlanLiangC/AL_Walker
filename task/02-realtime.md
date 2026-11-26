# CityNav 连续写实闭环

在「任务配置」中选好任务和机器人，切到「机器人」视角，再选择「写实闭环 → EdenLive · 连续写实」。从「场景风格」下拉框选择预设或自定义，编辑提示词后点击「生成参考帧」。画面出现后，按「开始」并用 W、A、S、D 和空格驾驶。可随时切换到「原画」。

Qwen-Image 2.1 按开局机位生成参考图。EdenLive 5B 使用同一参考图、场景风格和持续更新的 CityNav 控制画面。CityNav 独立以 20 Hz 推进交通、碰撞和信号灯。机器人显示画面保留视角安装位和实际地形坡度，移除合成步态带来的俯仰和高度振荡。原始传感器仍按各自预设采样。流服务超时会回到原画，并尝试重新接入当前任务。

## 启动

在项目根目录执行。已有环境可直接执行最后一行。界面默认使用实测的 864×480 配置。项目里尚无 SageAttention 时，启动脚本自动选择可用的 Ada FP8 配置。

```bash
bash tools/eden/prepare.sh all
bash tools/visual/prepare-generative.sh qwen-image
bash tools/world/prepare-live.sh
bash tools/visual/run.sh
```

入口为 [CityNav 机器人视角](http://127.0.0.1:8771/)。远程开发环境可转发 8771 端口。EdenLive、Cosmos3、REGEN FLUX、Pix2Pix-Turbo 和 Apple SHARP 都在「写实闭环」下拉框中。GPU 3 运行 EdenLive，GPU 2 运行 Cosmos3，GPU 1 运行其他渲染器，GPU 0 生成参考图。连续渲染模型启动时会预热。无认证同源入口使用二进制 WebSocket 图像流。受信任的跨域入口、带令牌的入口和 URL 带 `edenRtc=1` 的入口使用 WebRTC。启动终端中按 Ctrl+C 可停止服务。

在 [并排入口](http://127.0.0.1:8771/src/?eden=/eden&episode=office-09-x05&view=robot&edenCompare=1) 生成参考帧后，左边显示当前 CityNav 原画。右边显示 EdenLive 连续输出或 Cosmos3 的逐步输出。比较相同仿真步时可查看实测录像。

项目的环境、模型、编译缓存和实测文件位于 `.eden/`。参考图编辑器优先读取 `CITYNAV_PUBLIC_MODELS` 下的 Qwen-Image 2.1，共享目录只读。迁移时可以用 `bash tools/eden/archive.sh` 生成项目归档。目标节点 CUDA 或 PyTorch ABI 不同时，重新执行 `tools/world/prepare-live.sh`。需独立运行时，将 Qwen 权重放到项目的 `.eden/models/visual/qwen-image-21`。

## 导航器

连续观测在浏览器中返回 PNG Blob、画面对应的 `simTick`、相机位姿、`observation`、同一步的 `routeSignalState` 和会话的 `referenceSha256`。接口交付参考帧与直接使用 CityNav 控制帧生成的图像。交通状态、信号规则和车辆位置从 CityNav 获取。外部模式仅在 `CityNav.policy.step()` 时推进仿真。

```js
CityNav.policy.reset({ episodeId: 'office-09-x05', robotId: 'go2' });
const live = await CityNav.rendered.openLive({
  style: 'Photoreal street photography just after rain, wet asphalt and a cloudy sky.',
});
try {
  let frame = await live.next({ timeoutMs: 30_000 });
  const action = await navigatorPolicy(frame.image, frame.observation);
  const state = CityNav.policy.step(action, 4);
  frame = await live.next({ minTick: Math.round(state.time * 20) });
} finally {
  live.close();
}
```

`navigatorPolicy` 由接入方提供。若本次观测等待超时，可用同一个 `minTick` 重试读取。动作已经提交到 CityNav，应保存提交结果的 tick。

## 上机记录

单张 48 GiB RTX 4090 渲染，另一张卡生成参考帧。网页回放通过真实按键控制 Go2。采集到呈现以浏览器单调时钟计时。按键 p95 统计样本是脚本中配对到下一张直接受控图像的动作边沿。显示 FPS 计入过渡帧，独立仿真状态率按 tick 去重。

| 试验 | 显示 FPS | 每秒不同仿真步 | 采集到画面 p95 | 按键到受控图像 p95 |
| --- | ---: | ---: | ---: | ---: |
| 768×416，FP8，两潜帧／四步，WebRTC | 19.9 | 见明细 | 686 ms | 814 ms |
| 864×480，FP8，三潜帧／四步，WebSocket | 23.9 | 19.0 | 864 ms | 1,010 ms |
| 864×480，FP8，两潜帧／三步，WebSocket，细节车型 | 23.9 | 19.3 | 523 ms | 675 ms |
| 同上，停车等灯复测 | 23.7 | 19.4 | 519 ms | 600 ms |
| 最新版，停车等灯并验证断线恢复 | 23.9 | 19.6 | 533 ms | 594 ms |
| 最新版，网页实时并排 | 23.6 | 19.3 | 566 ms | 698 ms |
| 最新版，`market-09-x04` 暖光人潮，行人步态网格 | 23.8 | 19.3 | 515 ms | 575 ms |
| 同上，强制 WebRTC | 17.8 | 15.5 | 687 ms | 1,083 ms |
| 864×480，缩到一个潜帧，WebSocket | 4.0 | 3.7 | 661 ms | 847 ms |
| 960×544，FP8，两潜帧／三步，WebSocket | 16.0 | 13.2 | 913 ms | 1,001 ms |

键盘测试分别行进 24.95 m 和 16.13 m。等灯脚本继续前进时出现一次超速及一次与骑行者碰撞。两张卡已预热时，点击生成参考帧到首张连续写实帧约 18.5 秒。冷启动测得约 76 秒。断线时 CityNav 持续推进，从断开到收到新会话的当前受控画面约 1.3 秒。 [键盘压测](../.eden/results/realtime/browser-detailed/results.json) · [最新版同仿真步录像](../.eden/results/realtime/browser-release/original-and-generated.webm) · [冷启动与键盘指标](../.eden/results/realtime/browser-release/results.json) · [重连记录](../.eden/results/realtime/browser-release/recovery.json) · [热机并排指标](../.eden/results/realtime/browser-release-parallel/results.json)

测试导航策略读取每张 PNG 的左右亮度差来选择转向，取得 tick 0、4、8、12 的不同 PNG，CityNav 观测时间完全对齐，参考 SHA256 一致。相同接口也用市场任务与中文雨后提示词验证。Go2、B2、G1 各自通过 2,160 个标准任务及 48 个极限任务的参考控制器回归。 [导航观测](../.eden/results/realtime/external-final/navigator.json) · [由图像计算的动作](../.eden/results/realtime/external-final/actions.json) · [中文提示词测试](../.eden/results/realtime/external-cn/navigator.json) · [Go2 标准任务](../.eden/results/realtime/standard-regression.json) · [B2 标准任务](../.eden/results/realtime/standard-b2.json) · [G1 标准任务](../.eden/results/realtime/standard-g1.json)

双卡上下文并行的 1280×704 同输入回放实测 5.8 FPS，硬件查询显示卡间未开放点对点传输。当前默认使用单卡 864×480。 [双卡回放指标](../.eden/results/realtime/context-720/metrics.json) · [暖光人潮指标](../.eden/results/realtime/browser-walkers/results.json)

写实度仍需通过指定样片后两列的验收。升级网格保住了部分近车的轮廓、车门和轮毂。去掉随灯色切换的全局提示后，车身串色减少。对源图确认可见且生成结果已有颜色的灯头，局部校正使用 CityNav 的灯态和投影区域。急转时建筑立面仍会扭曲，生成结果也可能漏掉灯头。固定轨迹增强结构特征后，个别立面轮廓更完整，强遮挡时仍会生成位置错误的车辆。参考照片投影实验只需约 44 ms 完成按键到绘制提交，离开首帧覆盖的表面后会逐渐露出简化几何。目前作为 `renderBench=1` 的对照方式。 [固定轨迹 A/B](../.eden/results/realtime/spatial-ab.jpg) · [指定画质目标](../.eden/results/quality/streaming-comparison/frame-032.png) · [照片投影延迟](../.eden/results/realtime/browser-projected/results.json)

```bash
source tools/eden/env.sh
"$EDEN_PY" tools/world/check-live.py --output .eden/results/realtime/retest-keyboard
"$EDEN_PY" tools/world/check-live.py --external --output .eden/results/realtime/retest-navigator
```

## 其他渲染器

| 方案 | 与 CityNav 闭环的关系 |
| --- | --- |
| SolarRenderer | 已完成 CityNav 机器人短片和网页键盘验证。当前原生短片路径的单次续帧约 183 秒。 [本机实测](02-reference-world.md) |
| Code World Model 2.0 | 可传参考帧和逐步控制数据。公开生产配置使用 8 卡，本机公共权重缺两片，匹配的冻结组件也未就绪。 [部署及缺项](02-reference-world.md) |
| Cosmos3-Nano-Sim-Transfer | 本项目在公开的整片推理实现上加入逐步会话，用 CityNav 的同步深度生成开局图和后续观测。单张 4090 上热机每步约 0.65 秒。NVIDIA 在 GB200 演示中报告 640×640、15.85 FPS 和 240 ms。 [本地闭环与画质](02-reference-world.md#cosmos3-深度写实) · [NVIDIA 实测](https://research.nvidia.com/labs/cosmos-lab/cosmos-simulation/) · [公开推理实现](https://github.com/vllm-project/vllm-omni/pull/10766) |
| StreamRender-H3 | 公开模型使用 8 张 GB200 和 NVLink 验证，可借鉴短块因果渲染。 [官方发布](https://huggingface.co/yitongl/StreamRender-H3) |
| NVIDIA NuRec | 多视角真实采集可用于高质量、可重定位的静态外观。每个新场景需要相应的采集和注册数据，动态机器人任务还要连接 CityNav 的交通体。 [采集与重建文档](https://docs.nvidia.com/nurec/) |

## 布局导出及三种渲染器

`--layouts` 会在同一仿真步和机位采集 RGB、深度和逐像素类别。`rgb/` 和 `labels/` 使用相同的尺寸，标签 PNG 存放 Cityscapes `labelIds`。`depth-mm/` 保存沿相机轴的三通道小端序毫米值，尺寸 256×144，零表示无命中的像素。`truth.json` 按帧提供 tick、OpenCV 内外参和动态参与者的米制位姿。`scene.json` 保存任务的道路、建筑、静态道具和其他场景布局。RGB、类别边界和相机运动可作为不同渲染器的输入。

```bash
source tools/eden/env.sh
layout=.eden/results/alternatives/office-layout
"$EDEN_PY" tools/eden/export_clip.py --url http://127.0.0.1:8771 \
  --replay assets/eden/office-crossing/replay.json --frames 114 --view robot \
  --width 832 --height 480 --layouts --detailed --output "$layout"
CUDA_VISIBLE_DEVICES=1 bash tools/world/run-alternatives.sh --method regen \
  --layout "$layout" --output .eden/results/alternatives/retest-regen
CUDA_VISIBLE_DEVICES=1 bash tools/world/run-alternatives.sh --method edge-turbo \
  --layout "$layout" --label-edges --output .eden/results/alternatives/retest-edge
CUDA_VISIBLE_DEVICES=1 bash tools/world/run-alternatives.sh --method sharp \
  --layout "$layout" --reference .eden/results/alternatives/static-reference.png \
  --output .eden/results/alternatives/retest-sharp
```

SHARP 的参考图需来自导出序列的第一台相机。`--foreground` 可指定同一序列的逐帧 RGB 结果，用 CityNav 语义遮罩合成当前车辆、行人和信号灯，并填补高斯场景未覆盖的像素。这个模式使用只含静态场景的开局参考图。参照图生成和高斯场景重建各执行一次。Apple 权重适用其研究用途许可。 [SHARP 官方说明及权重许可](https://github.com/apple-aiml-research/ml-sharp)

源码、依赖和权重位于 `.eden/world/alternatives/`。所有推理使用项目内已有的 PyTorch。SHARP 首次使用 CUDA 扩展需要编译，扩展缓存写到项目目录。三种方案使用同一台 48 GiB RTX 4090 的 832×480 输入，计时包含推理和结果读取。网页传输和参考图片生成分别计量。基准运行文件随项目归档迁移。

| 渲染器 | 本机续帧中位耗时 | 同机位检查 |
| --- | ---: | --- |
| REGEN | 16.3 ms，约 59–61 FPS | 输入 CityNav RGB。FLUX 蒸馏权重在近车和转向时保住了车辆、路缘及建筑轮廓，并增强了铺装和立面纹理。使用权重内固定的风格，部分画面偏暗。 [官方源码](https://github.com/stefanos50/REGEN) · [实测](../.eden/results/alternatives/turn-regen/metrics.json) |
| Pix2Pix-Turbo | 157 ms，约 6.4 FPS | 输入 CityNav 边缘与语义边界，支持文字提示。生成画面有真实材质，灯态和地面分类仍会漂移。512×288 复测约 11.6 FPS。 [官方源码](https://github.com/GaParmar/img2img-turbo) · [832×480 实测](../.eden/results/alternatives/turn-edge/metrics.json) · [512×288 实测](../.eden/results/alternatives/turn-edge-512/metrics.json) |
| Apple SHARP | 2.0 ms | 从开局参考图重建 118 万个高斯，同一步使用当前 CityNav 相机位姿。重建用了 5.8–9.9 秒。窄范围保有照片纹理，车辆会停留在参考图位置，急转后新视野只剩少量有效覆盖。以静态参考和语义遮罩合成当前动态体后，车辆恢复正确的位置，转向缺口由 REGEN 画面补足，交界处仍可见。 [官方源码](https://github.com/apple-aiml-research/ml-sharp) · [相机覆盖](../.eden/results/alternatives/turn-sharp/metrics.json) · [合成结果](../.eden/results/alternatives/turn-hybrid/metrics.json) |

画质检查使用 `office-09-x05` 的 Go2 相机。直行测了 114 帧，额外停等、开动和大幅转向的轨迹抽了 27 帧。 [直行原画与渲染对照](../.eden/results/alternatives/rgb-rerender.jpg) · [转向原画、布局和渲染对照](../.eden/results/alternatives/turn-comparison.jpg)

在统一入口的「写实闭环」中选择 REGEN FLUX 即可驾驶。单路基准的同源 WebSocket 在 307 帧键盘测试中达到 24.0 FPS，每秒对应 19.9 个不同仿真步，采集到屏的 p95 为 82.5 ms。WebRTC 的对照测试为 21.2 FPS 和 156 ms。 [键盘转向截图](../.eden/results/alternatives/browser-regen/keyboard-3.png) · [浏览器实测](../.eden/results/alternatives/browser-regen/results.json)
