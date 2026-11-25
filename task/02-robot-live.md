# CityNav 机器人第一视角实时并排

机器人视角采用 CityNav 的 Go2 前向机位。左侧原画从当前仿真状态直接渲染，右侧显示已到屏的写实帧并标注延迟。「对照」继续使用与增强帧具有同一输入帧编号的原画，便于复核。浏览器断网检查通过，原画持续推进，右侧清除旧画面，恢复网络后增强重新出画。 [断网记录](../.eden/results/robot-live/outage.json)

用 `office-09-x05` 的同一组 20 秒动作分别验证 640×352 与 1280×704。两档均使用 24 FPS 输入、5B 四步、LightTAE 和机器人视角写实首帧。首帧按 CityNav 原图构图，用内置图生图生成，试验风格为多云自然日光。写实首帧在两个档位都由浏览器实际命中。表中时延为采集到屏。 [场景配置](../assets/eden/office-robot/style.json) · [参考首帧](../assets/eden/office-robot/cover.png) · [首帧生成提示](../assets/eden/office-robot/cover-prompt.md)

| 增强分辨率 | 原画每秒仿真步 | 增强实际新帧 FPS | 增强到屏 p95 | 两侧相差 p95 |
| --- | ---: | ---: | ---: | ---: |
| 640×352，不录像 | 19.85 | 21.90 | 0.89 秒 | 17 tick |
| 640×352，录像 | 19.95 | 22.40 | 0.94 秒 | 19 tick |
| 1280×704，不录像 | 20.00 | 5.86 | 3.08 秒 | 61 tick |
| 1280×704，录像 | 19.60 | 4.21 | 2.52 秒 | 50 tick |

640 版早段有写实的路面和车身材质。按增强帧自己的 tick 核对，第 351 tick 的信号仍有红绿错误，路面也出现了额外绿光。720p 版出现输入积压，多次重建模型历史时使用了当前灰盒帧作为首帧，部分输出重新接近原画。两档增强开关下的 CityNav 轨迹、状态与原始机载观测一致。 [浏览器实录](../.eden/results/robot-live/demo/office-robot-live.mp4) · [第 351 tick 同帧复核](../.eden/results/robot-live/tick-351-same-frame.png) · [640 测量记录](../.eden/results/robot-live/640-timing/office-09-x05.json) · [720p 测量记录](../.eden/results/robot-live/720-timing/office-09-x05.json)

实测通过了机器人第一视角的同屏并行显示和原画连续操控。以 task/02 的 ≥20 FPS 与 p95 ≤800 ms 衡量，两档都未通过实时增强验收，灯色也未通过语义验收。
