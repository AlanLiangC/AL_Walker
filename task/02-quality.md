# CityNav × EdenLive 5B 画质评估

选用 `office-09-x05` 的 Go2 追踪视角。条件视频固定为 CityNav 录制的 1280×704、24 FPS、无 HUD RGB，模型随机种子固定为 42。长片 477 帧，覆盖停车、信号变相和起步。CityNav 在帧号 403（16.792 秒、tick 336）记录到下一处人行横道从红灯变绿。短片从 tick 285 开始，配有重做的对齐首帧，变相在短片帧号 61。两张写实首帧以对应的 CityNav 图做图生图，保留机位和主体构图，采用阴天湿路作为本轮试验风格。逐帧真值记录相机、机器人、信号和近处交通体。 [长片输入](../assets/eden/office-crossing/) · [短片输入](../assets/eden/office-signal-change/) · [EdenLive 输入规格](https://github.com/VAST-AI-Research/EdenLive/blob/2ea01626e6eaa32592a3b466d99d9739ceca35b0/README.md#your-own-data)

## 四步自回归

每项都生成全部 477 帧。模型 FPS 按 GPU worker 生成时间统计，写盘 FPS 包含解码输入和编码输出，两者均排除进程的模型加载。GPU 为单张 RTX 4090，报告 49,140 MiB，使用 BF16。末列为 PyTorch 保留显存峰值。完整 WanVAE 在原有整批路径的第二个分段显存不足。单 latent 分段解码，沿用同一因果缓存后，完成全部帧。

| 尺寸 | 首帧 | 文本 | 解码器 | 模型 FPS | 含 I/O FPS | 峰值 MiB |
| --- | --- | --- | --- | ---: | ---: | ---: |
| 640×352 | 原画 | 旧通用 | LightTAE | 27.33 | 22.48 | 24,392 |
| 640×352 | 原画 | 场景静态 | LightTAE | 26.83 | 22.04 | 24,166 |
| 640×352 | 写实 | 场景静态 | LightTAE | 27.60 | 22.08 | 24,166 |
| 640×352 | 写实 | 场景＋事件 | LightTAE | 26.99 | 21.65 | 24,168 |
| 1280×704 | 原画 | 场景静态 | LightTAE | 7.38 | 6.66 | 31,168 |
| 1280×704 | 写实 | 场景静态 | LightTAE | 7.19 | 6.43 | 31,168 |
| 1280×704 | 写实 | 场景＋事件 | LightTAE | 7.36 | 6.64 | 30,452 |
| 1280×704 | 写实 | 场景静态 | WanVAE | 3.36 | 3.20 | 40,550 |
| 1280×704 | 写实 | 场景＋事件 | WanVAE | 3.39 | 3.23 | 40,550 |

- **首帧影响最大。** 用同一静态提示比较两个 720p 开局时，原画首帧延续了灰盒车辆和平坦路面。写实首帧在第 32 帧仍提供连续的湿路反光、玻璃、车身和路面材质，随后基本维持阴天光照。车辆仍可能出现额外轮廓或改变颜色。 [五列对照](../.eden/results/quality/streaming-comparison/comparison.mp4) · [第 32 帧](../.eden/results/quality/streaming-comparison/frame-032.png)
- **低分辨率会积累明显漂移。** 640×352 使用写实首帧时，早段确实改善。接近变相的第 408 帧，静态提示下有彩色挂条，事件提示下绿光溢到斑马线和道路。两个版本的第 468 帧都保留错色或光照伪影。 [低分辨率对照](../.eden/results/quality/preview-static-comparison/comparison.mp4) · [第 408 帧](../.eden/results/quality/preview-static-comparison/frame-408.png)
- **灯色受提示词影响，但不能保证同步。** 720p 写实首帧第 408 帧，静态 LightTAE 把近端绿灯画成黄灯。使用事件提示的 LightTAE 和 WanVAE 画对了近端绿色，远端同组灯仍为红色，第 468 帧也未同步；同时银色左车和粉色右车被画成黄色和绿色。在本片中，换完整 WanVAE 没有修复这些错误，解码让总体吞吐从 6.64 降到 3.23 FPS。 [静态与事件逐帧对照](../.eden/results/quality/event-comparison/frame-408.png) · [第 468 帧](../.eden/results/quality/streaming-comparison/frame-468.png)

五列长片视频从左至右为 CityNav 原画、640 旧档、720 原画首帧、720 写实首帧加事件和 LightTAE、最后一列改为 WanVAE。低分辨率对照从左至右为原画、旧档、写实静态、写实加事件。这里的对象和灯色是同帧人工复核记录，数值 FPS 来自运行日志。 [逐配置指标和原始视频](../.eden/results/quality/)

## 48 步双向离线

使用上游 5B 双向权重、1280×704、BF16、48 步和 CFG 3.0。保留上游分时间段文本条件，Ada 的分段交叉注意力用 Torch SDPA 实现。每段以 24 FPS 播放，共 121 帧，约 5 秒。结果反映此场景和种子的实测表现。

开局同窗对照中，双向版本在第 32 帧保留更多车辆轮廓，左侧少了四步版生成的发光车头，机器人和地面细节更稳定。第 116 帧右侧车辆的离场位置更接近源画。该次从进程启动到视频落盘约 8 分 34 秒。三列对照依次为 CityNav、四步自回归、48 步双向。 [并排视频](../.eden/results/quality/bidirectional-comparison/comparison.mp4) · [第 116 帧](../.eden/results/quality/bidirectional-comparison/frame-116.png) · [原分辨率输出](../.eden/results/quality/720-bidirectional/save/inference/base/office-crossing.mp4)

信号窗口使用重新对齐的写实首帧，两种模型共用片段和提示词。帧号 60 的中距离信号仍为红色，帧号 64 的双向结果把近端和中距离画成绿色，四步版本的近端混有橙色。最远端的小绿灯在双向版中仍暗或偏红。双向版继续保留左侧灰色厢车、右侧粉色车、骑行者及机器人的轮廓。本段约 8 分 21 秒落盘，共 121 帧。四步复核片段为同一输入的前 117 帧。 [变相视频](../.eden/results/quality/bidirectional-signal-comparison/comparison.mp4) · [帧号 64](../.eden/results/quality/bidirectional-signal-comparison/frame-064.png) · [实际文本时间轴](../.eden/results/quality/720-bidirectional-signal/save/inference/base/office-signal-change_text_timeline.json) · [原分辨率输出](../.eden/results/quality/720-bidirectional-signal/save/inference/base/office-signal-change.mp4)

在本次 5B 与 4090 测试中，48 步双向出片的短镜头效果最好；720p 四步加写实首帧是长回放中画质和耗时较均衡的配置。已观察到的远处信号错色与交通体漂移使增强 RGB 仍不符合 task/02 的语义门槛。

## 浏览器和迁移回归

- 用项目内运行环境启动真实 5B 浏览器服务。在 Go2 的待出发页面点击「对照」，核实第一帧为 tick 0、参考图命中、红灯事件来自 CityNav。点击开始并驾驶后仍为同一媒体会话，提交的画面与源帧的仿真 tick 一致。 [浏览器记录](../.eden/results/quality/browser-final/interactive.json) · [配对视频](../.eden/results/quality/browser-final/interactive-paired.webm)
- 从带空格的新目录读取项目内解释器、Torch、Chromium、上游代码和权重。离线城市和实景 HTML 都能驾驶，真实模型从该路径生成 9 帧。Go2 的对应场景复跑通过 20 个标准任务和 1 个极限任务。归档流核对了关键素材和运行文件。 [离线迁移](../.eden/results/quality/migration-offline.json) · [模型迁移](../.eden/results/quality/migration-native.json) · [归档清单检查](../.eden/results/quality/migration-archive-members.json) · [迁移命令](../services/eden/README.md#迁移)
