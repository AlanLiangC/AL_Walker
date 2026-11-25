# CityNav 机器人第一视角写实闭环

第一版提供两个可选的机器人第一视角。伦敦 Artillery Passage 使用 PlayCanvas 渲染实拍扫描，CityNav 负责地面、障碍碰撞和运动。办公区 `office-09-x05` 晴天使用 Cycles 渲染 CityNav 的相机、车辆、行人、骑行者、信号灯和场景几何。两条路径用同一套闭环接口。键盘驾驶每次推进两个 20 Hz 仿真 tick，收到对应图像后再推进。等待期间的短按在下一步生效。渲染超时或失败时保持状态，可重试或切回原画。

## 网页使用

伦敦实景可用新版 Chromium 直接打开 [artillery.html](../artillery.html)，也可访问服务的 `/src/?scene=scan`。点「实景闭环」，出画后点「开始任务」，用 WASD 驾驶，Esc 暂停。该入口使用既有扫描分块，可离线运行。

办公区 Cycles 服务在项目根目录启动。GPU 编号按目标机选择。

```bash
bash tools/visual/prepare.sh
bash tools/visual/run.sh --photo-gpu 3
```

打开 `http://127.0.0.1:8771/src/?eden=/eden&episode=office-09-x05&view=robot`。画面选项为「原画」和「写实闭环」。原画使用 CityNav 内置 WebGL 渲染器。写实闭环使用 Blender 4.5.17 LTS 的 Cycles 路径追踪，默认用 NVIDIA OptiX。点「写实闭环」，出画后点「开始任务」，用 WASD 驾驶，Esc 暂停。

材质、曝光、采样数、HDR 天空和车型替换路径集中在一个 JSON。场景几何、许可、Python、Blender 和素材随项目放置。已在另一个带空格的目录启动复制后的项目，并用另一张 GPU 渲染 1280×704 PNG。 [场景风格](../assets/visual/office-day.json) · [素材许可](../assets/visual/NOTICE.md) · [归档脚本](../tools/eden/archive.sh) · [迁移测试帧](../.eden/results/visual/migration.png)

## 导航器观察和推进

页面里的 `CityNav.rendered` 接入 CityNav 外部控制模式。观察返回 PNG Blob、图像所属 tick、相机以及此时的 CityNav 策略观测。只有当前状态刚签发的观察 ID 可以推进。上一步推进成功但下一张图请求失败时，可对当前状态重新调用 `observe()`。重复使用旧 ID 会被拒绝。伦敦实景传 `taskId: 'artillery'`，办公区传 `episodeId: 'office-09-x05'`。外部模式接管后停止键盘渲染循环。

```js
CityNav.policy.reset({ taskId: 'artillery', robotId: 'go2' });
let view = await CityNav.rendered.observe();
const action = await controller.decide(view.image, view.observation);
view = await CityNav.rendered.step(action, {
  observationId: view.observationId,
  ticks: 2,
});
```

## 验证与限制

- 原显示相机直接使用了传感器步态。在该固定回放中，去掉显示相机的步态项消除了最高约 1.72° 的俯仰偏移和 3.4 cm 的相机高度偏移。地形俯仰、安装角和原始机载传感器仍按 CityNav 原有逻辑计算。 [相机轨迹对照](../.eden/results/visual/camera-motion.json)
- 两条路径均通过键盘与读图推进测试。刻意延迟一次图像响应，确认仿真时间保持且短按转向在下一步生效。各完成 6 次读图决策，复用旧 ID 被拒绝，相同动作在 CityNav 重放得到相同状态。 [伦敦闭环记录](../.eden/results/visual/scan-browser/browser.json) · [办公区闭环记录](../.eden/results/visual/final-browser/browser.json)
- 伦敦入口使用实拍重建的静态街巷，抓帧等待 PlayCanvas 完成当前相机的排序。排除开局和故意延迟的帧后，17 张键盘图像的渲染和 PNG 编码耗时为 p50 96 毫秒、p95 106 毫秒。碰撞来自 CityNav 的对齐几何。转向撞石柱测试确认 CityNav 记录了碰撞、将速度归零，导航器收到对应位置的图像。扫描路线目前只有静态障碍，靠近扫描边界仍可能看到重建缺口。 [导航器图像](../.eden/results/visual/scan-browser/navigation.png) · [石柱碰撞图像](../.eden/results/visual/scan-browser/collision.png) · [PlayCanvas 帧就绪说明](https://developer.playcanvas.com/user-manual/gaussian-splatting/building/render-on-demand/)
- 使用同一条回放的第 335、337 tick 扫查 (v1-2) 横道信号。相机和交通对象都取自对应状态，图像随 CityNav 真值从红色变为绿色。 [红灯帧](../.eden/results/visual/tick-335.png) · [绿灯帧](../.eden/results/visual/tick-337.png)
- 单张 48 GB RTX 4090 执行 1280×704、16 样本、OptiX 降噪。18 张非开局键盘图像的渲染耗时为 p50 0.90 秒、p95 0.97 秒。晴天试验场景中，路面和天空使用照片资产，轿车使用详细车型。其他厢车、行人、骑行者以及街景几何仍有明显简模感。**整幅画面的实拍级真实性尚未通过验收。**

## 其他渲染器

| 候选 | 对 CityNav 的适配判断 |
| --- | --- |
| **Blender Cycles / OptiX** | 本轮已实测。可在同一状态停住时增加采样并按相机出 PNG。适合建立逐状态画质参考，当前耗时适用于慢速闭环。 [OptiX 官方文档](https://docs.blender.org/manual/en/4.5/editors/preferences/system.html) |
| **Isaac Sim / Omniverse RTX** | 适合后续导航器接入。USD 相机支持内参、RGB、深度及语义等输出，可选择 RTX 实时或路径追踪。需要绑定 CityNav 的实体 ID、变换和灯色，并以 CityNav 为唯一仿真时钟。此处判断来自接口文档。 [相机文档](https://docs.isaacsim.omniverse.nvidia.com/6.2.0/sensors/isaacsim_sensors_camera.html) · [渲染档位](https://docs.isaacsim.omniverse.nvidia.com/6.2.0/reference_material/rendering_modes.html) |
| **Unreal Engine / Lumen** | 适合需要高质量城市资产、并向连续交互推进的版本。可把外部状态映射到可移动场景实体。性能取决于场景、光照和硬件，需要在 CityNav 目标场景实测。 [Lumen 性能指南](https://dev.epicgames.com/documentation/en-us/unreal-engine/lumen-performance-guide-for-unreal-engine) |
| **CARLA 1.0 / UE5.8** | 提供较完整的道路、车辆、行人和传感器素材。若作为渲染后端，需要覆盖交通、信号和车辆变换，并处理 CARLA 自身世界时钟的接管。 [CARLA 1.0 官方发布](https://carla.org/2026/11/17/release-1.0/) |
| **PlayCanvas / Gaussian Splatting** | 本轮已在伦敦实景闭环验证。渲染静态扫描，可进一步叠加由 CityNav 驱动的动态体。光照重建与可迁移范围取决于采集和代理几何质量。 [PlayCanvas 重光照说明](https://developer.playcanvas.com/user-manual/gaussian-splatting/building/relighting/) |
