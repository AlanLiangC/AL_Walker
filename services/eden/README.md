# CityNav × EdenLive

打开项目根目录的 `index.html` 可离线驾驶。伦敦实景入口是 `artillery.html`。联网增强启用后，追踪和机器人视角可以切换原画、增强、对照。对照的左侧显示送入服务的源帧，右侧显示同一源帧对应的模型输出。俯视显示原画。暂停、重试、切场景、切换相机和复位会释放旧画面。拖动与缩放使用当前连续会话。

「实时并排」左侧直接显示当前 CityNav 相机，右侧显示最新到屏的写实帧。两侧显示同一相机的不同采样时刻，右侧延迟见画面控制栏。增强等待、断网或回退时，左侧继续显示 CityNav，右侧显示状态。机器人第一视角实测见 [并排验收](../../task/02-robot-live.md)。

## 环境与权重

所有运行文件默认放在项目内的 `.eden/`。在项目根目录执行。

```bash
source tools/eden/env.sh
bash tools/eden/prepare.sh env
bash tools/eden/prepare.sh weights
bash tools/eden/prepare.sh browser
bash tools/eden/prepare.sh bidir
```

准备脚本用 uv 将 CPython 3.12.13 和全部 Python 包落在项目内。CUDA 基线为 PyTorch 2.11.0+cu128、TorchVision 0.26.0+cu128、Transformers 4.57.6。应用、依赖与 CUDA 用户态库版本见 [requirements.lock](requirements.lock)。双向高画质配置需要额外约 20 GB 权重。模型、浏览器、缓存、临时文件和录像均写入项目。目标机需要兼容的 Linux x86_64、NVIDIA 驱动和 Chromium 所需系统库。

- 源码固定为 EdenLive `2ea01626e6eaa32592a3b466d99d9739ceca35b0`。推理复用该提交的 Reactor 原生 5B 后端、四步采样器和缓存。CityNav 媒体适配器负责源帧身份、同屏对照和会话资源调度。[上游提交](https://github.com/VAST-AI-Research/EdenLive/tree/2ea01626e6eaa32592a3b466d99d9739ceca35b0)
- 权重固定为 `4efc2c4c33af7863f6048e36c2bceb2c30bfae97`。5B 所需子集约 37 GB，下载器支持续传并核验 LFS SHA-256。运行时从本地打开权重，PyTorch worker 分别缓存已编码的提示词。[权重与组件许可证](https://huggingface.co/VAST-AI/EdenLive/tree/4efc2c4c33af7863f6048e36c2bceb2c30bfae97)
- DiT、Wan VAE、LightTAE 及文本组件的来源见模型卡。Proxy-DINO 骨干与投影适用 DINOv3 License，研究发表须按组件 NOTICE 做致谢。[Proxy-DINO NOTICE](https://huggingface.co/VAST-AI/EdenLive/blob/4efc2c4c33af7863f6048e36c2bceb2c30bfae97/vision-encoder/NOTICE.md)

## 本机启动

```bash
# 直通自检，浏览器打开 http://127.0.0.1:8765/
bash tools/eden/run.sh passthrough

# 一张卡，浏览器打开 http://127.0.0.1:8766/
bash tools/eden/run.sh ada-preview --port 8766 \
  --gpu 0 \
  --references "$CITYNAV_EDEN_ROOT/references/640x352"

# 四卡各一个常驻进程，浏览器打开 http://127.0.0.1:8767/
bash tools/eden/run.sh ada-640x352-24 --port 8767 \
  --gpu 0 --gpu 1 --gpu 2 --gpu 3 \
  --references "$CITYNAV_EDEN_ROOT/references/640x352"
```

用 `nvidia-smi -L` 核对目标机卡号或 UUID。用 `curl http://127.0.0.1:8766/eden/health` 查看逐卡加载、预热、进程 ID、显存和忙闲状态。每个 worker 独占一个会话。页面关闭、暂停或切场景后会释放媒体，GPU 处理完在途片段后清理本轮缓存。测试 worker 中止后服务尝试重新预热该卡，浏览器保持原画并按退避重连。终端中用 Ctrl-C 结束服务。

`ada-720p` 使用原生 1280×704、24 fps 输入。 `ada-preview` 将画面和 DINO 目标 latent 缩至 640×352、12 fps 输入，`ada-640x352-24` 将同尺寸输入调至 24 fps。三档都保持投影宽高比，默认采用 BF16、四步、Torch SDPA 和 LightTAE。另提供 `ada-preview-flash`、`ada-preview-vae`、`ada-preview-graph` 和 `ada-preview-compile` 用于同输入对照。预览与评估的名字表示配置用途，实测发布档位见验收结果。

部署可由同一个服务提供网页与媒体信令，或在受信任的 HTTPS 页面通过 `?eden=https://主机/eden` 指定端点。服务支持 `--host`、`--cert`、`--key` 和 `--allow-origin`。使用 `CITYNAV_EDEN_TOKEN` 时，通过部署页的 `window.CityNavEdenConfig={endpoint,token,iceServers}` 注入当前用户的配置。局域网先测试 UDP 直连，再按需要配置浏览器 ICE 与服务端 `CITYNAV_ICE_SERVERS`。访问网页的 TCP 反代与 WebRTC 的媒体网络分开配置。

## 帧与首帧参考

源轨每次采集固定视图相机、仿真 tick 和单调时钟。在画面下的 16 像素媒体边缘标注 CRC 校验帧号。服务在进入模型前裁去标记，返回带独立序号的同屏源帧与增强帧。浏览器在 `requestVideoFrameCallback` 读取媒体时间与 RTP 时间戳，并通过回传序号、会话和 epoch 核对元数据再提交可见画布。模型直接使用的条件帧与生成的区间帧都记录来源。迟到、无映射、重复帧与输入背压分别计数。浏览器侧到屏时延以可见画布提交时的单调时间计算。

自定义风格使用 `--style` 加载 JSON。必填的 `staticPrompt` 描述场景材质和摄影风格，`weatherPrompts` 和 `signalPrompts` 可选。可用 `episodeId`、`robotId`、`cameraMode` 限定应用场景。 `references` 列出同配置文件相对的首帧清单。每份清单记录 Episode、仿真种子、机器人、视角、天气、tick 和相机的 `eye`、`target`、`fov`。参考图必须与源画幅同宽高比；当运行时状态和构图匹配时模型采用它，否则以当前无路线标记的源画面开局。原有 `--references` 继续支持按 `<episodeId>-<seed>-<cameraMode>-<weather>.png` 加载 tick 0 的图片和相机清单。

示例使用同一地点的 CityNav RGB、写实首帧与事件提示。网页在待出发状态选择「对照」，待首帧出现后点击「开始任务」可沿用开局历史。 [风格示例](../../assets/eden/office-crossing/style.json) · [首帧清单](../../assets/eden/office-crossing/anchor.json) · [时间提示](../../assets/eden/office-crossing/prompts.json)

```bash
bash tools/eden/run.sh ada-720p --port 8768 --gpu 0 --style assets/eden/office-crossing/style.json
# http://127.0.0.1:8768/src/?eden=/eden&episode=office-09-x05&edenLegacy=1
```

机器人第一视角可用下方的写实首帧配置。浏览器打开 `http://127.0.0.1:8769/src/?eden=/eden&episode=office-09-x05&view=robot&edenLegacy=1`，在待出发时点「实时并排」，右侧出画后开始驾驶。

```bash
bash tools/eden/run.sh ada-640x352-24 --port 8769 --gpu 0 --style assets/eden/office-robot/style.json
```

## 迁移

直接复制项目代码、`assets/` 和 `.eden/` 中的运行环境与模型数据，或用下面的 tar 流导入目标工作区。运行包包含浏览器、权重、项目 Python、依赖、上游源码、参考素材和结果。项目缓存和临时目录由启动脚本创建。选择目标机的 GPU 编号后即可启动。

```bash
bash tools/eden/archive.sh | tar -xf - -C /path/to/destination/AL_Walker
```

## 按同一回放评估画质

输入包结构与 EdenLive 的 recording manifest 一致。每个素材目录含无 HUD 的 `recording.mp4`、同相机参考 `cover.png` 和 `prompts.json`。用 `export_clip.py` 从 CityNav 回放重建 1280×704、24 FPS 输入和逐帧真值。用支持图生图的工具把 `first-frame.png` 改成目标画风，保留机位、主体和道路布局，再用 `appearance_inputs.py` 写出首帧清单和时间提示。

```bash
source tools/eden/env.sh
clip=assets/eden/office-crossing
# 先在另一终端运行 bash tools/eden/run.sh passthrough
"$EDEN_PY" -m tools.eden.export_clip --replay "$clip/replay.json" --output "$clip" --frames 477
"$EDEN_PY" -m tools.eden.appearance_inputs "$clip" --weather day

CUDA_VISIBLE_DEVICES=0 PYTORCH_ALLOC_CONF=expandable_segments:True \
  "$EDEN_PY" -m tools.eden.quality --recording "$clip" --source "$EDEN_SOURCE" \
  --weights "$EDEN_WEIGHTS" --profile ada-720p --events --seed 42 \
  --output "$CITYNAV_EDEN_ROOT/results/quality/720-cover-light-events"

PYTORCH_ALLOC_CONF=expandable_segments:True bash tools/eden/offline.sh 0 \
  "$CITYNAV_EDEN_ROOT/results/quality/720-bidirectional" bidirectional assets/eden/manifest.csv 121
PYTORCH_ALLOC_CONF=expandable_segments:True bash tools/eden/offline.sh 0 \
  "$CITYNAV_EDEN_ROOT/results/quality/720-bidirectional-signal" bidirectional assets/eden/signal-change.csv 121
```

将 `--anchor first-frame.png` 用于原画开局对照，移除 `--events` 可固定整段提示。用 `ada-720p-vae` 可测试完整 WanVAE。双向离线采用上游 5B 48 步配置，Ada 上使用项目内补丁将分段文本交叉注意力切到 Torch SDPA。输出视频保持 24 FPS 的播放时间轴，计算吞吐单独记录。[5B 画质评估](../../task/02-quality.md)

## 重跑验证

```bash
source tools/eden/env.sh
node tools/eden/replay.mjs "$CITYNAV_EDEN_ROOT/results/replays"
python3 build.py

"$EDEN_PY" tools/eden/probe.py --output "$CITYNAV_EDEN_ROOT/results"
"$EDEN_PY" tools/eden/browser.py --offline --output "$CITYNAV_EDEN_ROOT/results"
"$EDEN_PY" tools/eden/browser.py --video --output "$CITYNAV_EDEN_ROOT/results/passthrough"
"$EDEN_PY" tools/eden/reference.py --replays "$CITYNAV_EDEN_ROOT/results/replays" \
  --output "$CITYNAV_EDEN_ROOT/references/640x352"

"$EDEN_PY" -m tools.eden.benchmark --profile ada-720p --source "$EDEN_SOURCE" \
  --weights "$EDEN_WEIGHTS" --gpu 0 \
  --output "$CITYNAV_EDEN_ROOT/results/eden/benchmarks"
bash tools/eden/offline.sh 0
"$EDEN_PY" tools/eden/browser.py --url http://127.0.0.1:8766 --video \
  --output "$CITYNAV_EDEN_ROOT/results/eden"
"$EDEN_PY" tools/eden/browser.py --url http://127.0.0.1:8766 --video \
  --replays "$CITYNAV_EDEN_ROOT/results/replays" --output "$CITYNAV_EDEN_ROOT/results/eden/replays"
"$EDEN_PY" tools/eden/policy.py --url http://127.0.0.1:8766 \
  --output "$CITYNAV_EDEN_ROOT/results/eden"
"$EDEN_PY" tools/eden/stress.py --url http://127.0.0.1:8767 --inject-worker-exit \
  --output "$CITYNAV_EDEN_ROOT/results/eden/stress"
python3 tools/eden/acceptance.py --results "$CITYNAV_EDEN_ROOT/results" \
  --output "$CITYNAV_EDEN_ROOT/results/acceptance.json"
```

本机 Chromium 硬件加速参数为 `--chrome-arg=--use-gl=angle --chrome-arg=--use-angle=vulkan --chrome-arg=--enable-features=Vulkan --chrome-arg=--disable-vulkan-surface --chrome-arg=--disable-gpu-sandbox`。录像工具也接受通过 `--chromium` 指定的本地 headless shell。直通和真模型证据各使用自己的服务端口和目录。

固定回放记录逐 tick 动作、相机视角、近处物体候选和信号真值。视频左侧为配对源画面，右侧为同一采样的回显。语义复核按可判读对象记录新增、消失、信号错色、遮挡和漂移。候选框与人工可判读对象需逐段确认。独立测试策略从机载 RGB 下半部的边缘数据计算转向，使用本轮已送达的原始 IMU、GPS 时间戳记录，等待下一步前对同一 RGB 采样做来源校验。实验输出每轮样本、动作、下一步位姿和超时回退。
