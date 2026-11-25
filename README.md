# CityNav 城市导航仿真

在 Finder 中双击根目录的 [index.html](index.html)，用 Chrome、Edge 或 Safari 打开。页面可离线运行，无需启动服务器。[dist/index.html](dist/index.html) 是同一份单文件入口。在 IDE 中点击 HTML 链接可能只会打开源码标签页。

点击 **任务配置** 选择路线、机器人、仿真环境、场景随机种子和传感器。默认装载 Go2 参考型的 RGB 相机、2D LiDAR、IMU 和 GPS。可以安装多个同类型传感器。

| 操作 | 键盘 |
| --- | --- |
| 前进、后退 | W / S 或 ↑ / ↓ |
| 左转、右转 | A / D 或 ← / → |
| 慢行至约 0.78 m/s | Shift |
| 制动 | 空格 |
| 追踪、机器人、俯视 | C 或视角按钮 |
| 复位当前视角 | V 或画面右上角的「复位」 |
| 全屏驾驶 | F 或画面右上角的「全屏」 |
| 暂停、继续 | Esc |

在 3D 画面里按住鼠标左键或用单指拖动，可以旋转追踪或俯视镜头，也可以在机器人视角转头查看四周。滚轮或双指捏合缩放，双击画面可复位。触屏提供方向键、制动和可切换的慢行。机器人视角默认使用第一台相机的安装位，也可在传感器面板选择。拖动和缩放只改变显示镜头，传感器面板和模型接口继续使用仿真机载观测。

地图支持全域与跟随，画面上的青绿色标记对应推荐路线。信号灯倒计时显示在路线侧栏，小屏也会在画面上显示。

## 模拟城市基准集

根目录入口默认打开「城市主干道 · 中心街坊」的通勤任务，点击 **场景库** 切换。每个场景包含 20 条固定 Episode。通过场景下拉框中的「经典城区」可访问原有 4 条路线。

- **108 个场景**来自 12 类街区，每类 9 个布局。包括主干道、老城窄巷、校门、公交换乘站、施工区、公园、滨水栈道、市场、医院、办公区、共享校园和物流园。布局变化涉及道路位置与宽度、封闭路段、横道类型、限速区、建筑与设施。
- **2,160 条 Episode**使用同一场景中不同的有方向起终点。任务分布包括高峰、低流量、配送车辆、密集行人、错峰信号、湿地、夜间和限时；每条任务记录随机种子、天气、时限及参考路线。
- **规则**包括信号灯、无灯横道来车间隙、停牌前停稳约半秒、护学横道开放时段、学区及候车区限速、非机动车道、施工区、装卸区和行人礼让。任务通过与否同时检查时限、安全分和严重事件。
- **训练、验证和测试按场景划分**，分别为 72 / 12 / 24 个场景、1,440 / 240 / 480 条 Episode。同一个场景下的所有任务属于同一划分。

[Episode 清单](benchmark/episodes.json) 包含可直接索引的 ID、种子、路点坐标、时限和横道类型。浏览器离线版可通过同样的 ID 加载任务。

```js
const { scenes, episodes, describeEpisode } = CityNav.catalog;
const heldOut = episodes.filter(episode => episode.split === 'test');
console.log(describeEpisode(heldOut[0].id));
const observation = CityNav.policy.reset({ episodeId: heldOut[0].id, robotId: 'go2' });
```

也可以直接从 `src/engine.mjs` 构造 `new CityEngine({ episodeId })`，无需渲染即可批量运行。重新生成清单用 `node tools/benchmark-manifest.mjs benchmark/episodes.json`。运行 `node tools/verify-benchmark.mjs` 可用参考控制器跑完整集合，也可传入 ID 前缀与机型，例如 `node tools/verify-benchmark.mjs school b2`。参考控制器使用场景真值检查任务可达性，其成绩用于任务回归。

### 极限挑战

点击 **场景库** 打开任务配置，再从场景库下拉框选择 **极限挑战**。其中有 48 条 Episode，每类 8 条。挑战沿用已有场景的训练、验证和测试划分。横穿人流、车辆间距与传感器扰动按种子复现。

| 挑战 | Episode 示例 | 任务条件 |
| --- | --- | --- |
| 暴雨强侧风 | `boulevard-02-x01` | 雨幕、湿滑制动、时变横向漂移 |
| 暴雪与结冰 | `school-02-x02` | 飞雪、积雪、低牵引力和更长的操控延迟 |
| 浓雾穿行 | `boulevard-08-x03` | 低对比度，深度和 LiDAR 的丢失率随距离上升 |
| 双向人潮瓶颈 | `market-09-x04` | 多股行人分批横穿机器人路线，需要找间隙并礼让 |
| 多车道路口排队 | `office-09-x05` | 每条机动车道有多辆车跟驰，在横道前排队和放行 |
| 雨夜晚高峰 | `transit-09-x06` | 暴雨、低照度、湿路反光、人流与车流同时出现 |

通过 `CityNav.catalog.challenges` 或清单里的 `challenges` 查找挑战。传入对应 `episodeId` 即可加载，运行 `node tools/verify-benchmark.mjs --extreme` 可检查极限挑战的可达性。

## 伦敦实景与城市雨夜

- 双击 [artillery.html](artillery.html)，即可从 Artillery Passage 北口走到南段店铺前，全程约 35 m。默认从机载相机视角开始。按 **Shift** 慢行绕过固定障碍，按 **F** 进入全屏。
- 实景入口约 63 MB，内嵌街巷扫描与 PlayCanvas，支持新版 Chrome 或 Edge 在本地离线运行。主入口仍约 2 MB。模拟城市的「任务配置 → 仿真环境 → 城市雨夜」提供实时街灯、机器人前灯、雨幕和湿路倒影。
- 实景 RGB 渲染的是经裁切的高斯泼溅。碰撞、示意地图、深度和 LiDAR 使用人工对齐的地面坡度、墙壁及固定障碍几何。深度帧标记为 `geometry: 'collision-proxy'`。该实景用例用于窄通道与固定障碍评测，信控与动态交通的用例仍在模拟城市。
- 实景与城市共用 `CityNav.policy`、任务结算和轨迹导出。实景的任务 ID 为 `artillery`。在机器人视角点「实景闭环」可按帧键盘驾驶，`CityNav.rendered` 可将同一状态的 PNG 交给导航器。 [接入方法](task/02-rendered-loop.md)

扫描由 David Fletcher 拍摄，采用 CC BY 4.0。CityNav 从 Will Eastcott 发布的 SOG 分块中裁切街巷，并对远处区域抽样。碰撞几何和导航在 CityNav 中维护。[原始扫描](https://superspl.at/scene/f4897475) · [SOG 来源](https://github.com/willeastcott/splat-walk) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## 路线与评估

| 任务 ID | 路线 | 场景 | 时限 |
| --- | --- | --- | ---: |
| `riverside` | 河湾公园西口至社区广场 | 公交站、人行横道、施工绕行、广场坡道 | 170 s |
| `market` | 图书馆东侧至社区诊所 | 信控斑马线、无灯斑马线、社区车辆 | 120 s |
| `library` | 滨河公交站至图书馆南门 | 候车行人、非机动车道、双向主路 | 110 s |
| `detour` | 青石商业街至社区东门 | 商业街、信控路口、围挡与锥桶 | 155 s |

进入终点 1.45 m 范围时结算。通过须在时限内、安全分至少 70，且无碰撞、闯红灯、违规穿越机动车道或闯入施工区。行人已在绿灯时进入斑马线的情况下可继续走完。仿真路段一般限速 2.00 m/s，斑马线和非机动车道限速 1.35 m/s，接近同一路径前方的行人或骑行者时应减至约 0.9 m/s 以下。完成后可导出配置、终态、全部违规和 20 Hz 驾驶轨迹为 JSON，也可用同一配置与种子重试。

## 仿真环境

| 预设 | ID | 用途与差异 |
| --- | --- | --- |
| 理想基线 | `ideal` | 即时控制、无噪观测，用于路线和规则回归 |
| 晴天户外 | `outdoor` | 程序化地表纹理与光照变化、控制延迟和转向惯性、地表牵引和机身起伏、交通速度变化、行人接近机器人时减速 |
| 湿滑低能见度 | `wet` | 增加湿路、雾霾、制动距离及深度和 LiDAR 无返回比例 |
| 城市雨夜 | `night` | 湿滑路面、实时雨幕、低照度、街灯和机载前灯 |

户外预设默认 RGB、深度、LiDAR 为 10 Hz，IMU 为 20 Hz，GPS 为 5 Hz。对应的默认延迟分别为 100、150、100、50 和 250 ms。每台传感器在配置中可独立设定 `rateHz`（1–20）和 `latencyMs`（0–1000）。采集和送达按 50 ms 仿真步长量化。可以用相同种子在晴天与湿滑预设间配对测试，两种预设共享随机采样的基础运动参数。

## 原画与写实闭环

「原画」由 CityNav 的 WebGL 渲染器绘制。「写实闭环」使用 Blender 4.5.17 LTS 的 Cycles 路径追踪。在办公区晴天的机器人第一视角，每次键盘推进等待与 CityNav 状态匹配的图像。 [启用方法、导航接口和实测](task/02-rendered-loop.md)

复现 EdenLive 的增强、同帧对照和实时并排实验时，在测试页面的 URL 加入 `edenLegacy=1`。 [EdenLive 部署说明](services/eden/README.md) · [5B 画质评估](task/02-quality.md) · [机器人第一视角并排实测](task/02-robot-live.md)

## 修改源码

在项目目录运行 `python3 -m http.server 8000`，在浏览器访问 `http://localhost:8000/src/` 调试模块源码。入口模板位于 [src/index.html](src/index.html)。用 `http://localhost:8000/src/?scene=scan` 调试实景。修改后运行 `python3 build.py`，重新生成根目录和 `dist/` 中的两个离线入口。

| 文件 | 扩展位置 |
| --- | --- |
| [src/city.mjs](src/city.mjs) | 路网、斑马线、灯相位、场景物件、任务路线和坡度 |
| [src/alley-world.mjs](src/alley-world.mjs) / [src/scan-renderer.mjs](src/scan-renderer.mjs) | 实景坐标、坡度和碰撞代理、高斯泼溅渲染 |
| [src/traffic.mjs](src/traffic.mjs) | 机动车、骑行者、行人路径与通行逻辑 |
| [src/engine.mjs](src/engine.mjs) | 固定步长、机器人状态、碰撞、计时和结算 |
| [src/domain.mjs](src/domain.mjs) / [src/measurements.mjs](src/measurements.mjs) | 环境预设、运动响应、传感器时钟、漂移、噪声和丢失 |
| [src/rules.mjs](src/rules.mjs) | 违规检测、扣分和严重事件 |
| [src/navigation.mjs](src/navigation.mjs) / [src/minimap.mjs](src/minimap.mjs) | 路线投影、转向与偏离提示、导航地图 |
| [src/sensors.mjs](src/sensors.mjs) | 机器人参数、安装位变换、LiDAR 和定位观测 |
| [src/geometry.mjs](src/geometry.mjs) / [src/renderer.mjs](src/renderer.mjs) | 程序化网格、WebGL 相机和深度帧 |
| [src/lighting.mjs](src/lighting.mjs) / [src/materials.mjs](src/materials.mjs) / [src/street-detail.mjs](src/street-detail.mjs) | 天空、材质、阴影、湿路反射与街道细节 |
| [src/configuration.mjs](src/configuration.mjs) / [src/app.mjs](src/app.mjs) | 赛前配置、手动控制、HUD 和浏览器 API |

新增路线时，在 `city.mjs` 的 `tasks` 中填入 ID、起终点名称、限时、种子和有序途经点。地图自动绘制该路线，导航从途经点计算转向。车行道路段需用对应的斑马线衔接。

## 视觉样板与材质

默认的滨河通勤路线展示实拍天空、扫描材质、动态日照阴影和带枝叶动画的树木。湿滑预设增加路面反光和街景平面反射。驾驶视角与 RGB 相机共享实时场景，路面导航标记仅显示在驾驶视角。HTML 包含纹理，构建和运行均无需联网。

建筑、角色、交通工具和机器人采用代码建模。天空、地表和树叶素材来自 Poly Haven，使用 CC0 许可。[Poly Haven 素材许可](https://polyhaven.com/license)

| 纹理包 | 原始素材 |
| --- | --- |
| [地表颜色](assets/surfaces.webp) 与 [法线及粗糙度](assets/surface-relief.webp) | [Asphalt Track](https://polyhaven.com/a/asphalt_track) · [Floor Pavement](https://polyhaven.com/a/floor_pavement) · [Leafy Grass](https://polyhaven.com/a/leafy_grass) · [Brick Wall 13](https://polyhaven.com/a/brick_wall_13) · [Bark Willow 02](https://polyhaven.com/a/bark_willow_02) · [Concrete Tile Facade](https://polyhaven.com/a/concrete_tile_facade) |
| [树叶](assets/leaves.webp) | [Tree Small 02 的树叶颜色与透明度](https://polyhaven.com/a/tree_small_02) |
| [天空](assets/sky.jpg) | [Kloppenheim 06](https://polyhaven.com/a/kloppenheim_06) |

## 模型接入

`CityEngine` 可独立导入，支持无 DOM 和 GPU 的确定性动作步进与射线观测。浏览器端的 `CityNav.policy` 返回路线先验和机载观测，适合接真实部署策略。原有 `CityNav.reset`、`step`、`snapshot` 和 `observe` 提供带全局真值的诊断数据。外部控制模式下，仿真时间只由 `step` 推进。

```js
const sim = window.CityNav.policy;
sim.reset({
  taskId: 'library',
  robotId: 'g1',
  seed: 59,
  domain: 'wet',
  sensors: [
    { id: 'front', type: 'rgb', forward: 0.15, height: 1.24, pitch: -8, fov: 95 },
    { id: 'depth', type: 'depth', forward: 0.15, height: 1.24, pitch: -8, range: 30 },
    { id: 'scan', type: 'lidar', height: 0.85, yaw: 18, fov: 240, range: 28, rays: 121 },
    { id: 'imu', type: 'imu' },
    { id: 'gps', type: 'gps' }
  ]
});
const observation = sim.step({ throttle: 0.5, turn: 0.12, brake: false }, 4, { frames: true });
```

- `throttle` 和 `turn` 取值为 −1 至 1，正值对应前进和右转。每步 0.05 秒。相同初始配置和动作序列会复现同一仿真轨迹。
- `snapshot()` 返回位姿、仿真时间、分数、交通体状态、导航、事件及任务结果。结果为 `running`、`success` 或 `failed`。
- `policy.observe()` 和 `policy.step()` 返回当前仿真时间、任务状态、任务路线和传感器数据。全局机器人位姿、交通体状态、实时信号灯状态和传感器真值位姿只能通过诊断接口读取。
- `available:false` 表示首帧尚未送达，`sampleTime` 表示采集时的仿真时间，同一个样本可能返回多次。开启 `frames` 时，相机使用采样瞬间的机器人与交通体状态。
- 世界坐标采用 X 向东、Y 向上、Z 向南，单位为米。安装位的 `forward`、`right`、`height` 分别表示机身前、右、离地偏移。配置角度用度，观测中的姿态与 LiDAR 角度用弧度。
- RGB 为顶行起始的 `Uint8Array` RGBA 像素。深度为同排列的 `Float32Array`，单位为米，表示沿相机光轴的 Z 深度，0 表示无返回。两者分辨率均为 256 × 144。建议只在模型决策需要时调用 `observe({ frames: true })`。
- LiDAR 返回旋转扫描平面的距离、起始角、角步长和最大量程。无回波射线返回最大量程。IMU 提供合成角速度与比力。GPS 使用场景本地坐标，户外预设可出现定位漂移和 `fix:false`。
- 模型控制可在重置时指定 `recordTrajectory:true`，随后从 `CityNav.trajectory()` 读取 20 Hz 轨迹。记录同时包含输入指令与实际送达的指令，便于对齐实机数据。

## 用实测数据缩小迁移差距

当前范围是导航控制和交通规则评测。机器人采用简化运动学、圆形占地和交通体包围盒。户外预设的数值为初始假设，尚待目标设备校准。相机画面来自实时渲染的程序化几何与实拍材质。

1. **标定目标机器人。** 在固定直道录制带时间戳的控制命令、里程计、IMU 和相机。重复低速起步、急停和原地转向，测量命令到速度响应的延迟、停止距离和角速度上升时间。静止和移动时分别测定位漂移、有效深度比例和 LiDAR 返回范围。用这些统计量调整 `domain.mjs` 的参数。随机化方法见原始研究。[视觉域随机化](https://arxiv.org/abs/1703.06907) · [动力学域随机化](https://arxiv.org/abs/1710.06537)
2. **用真实场景覆盖感知和交互。** CODa 提供机器人第一视角的室外 RGB、RGB-D、3D LiDAR、IMU 与地形标注，适合检查几何覆盖和模态差异。SiT 的交互轨迹可用来比较行人速度、横穿时机和最近会车距离。视觉策略可参考四足人行道研究的做法，在部署端使用实机感知输出，在仿真端验证同一输入接口。[CODa](https://amrl.cs.utexas.edu/coda/) · [SiT](https://spalaboratory.github.io/SiT/) · [Learning to Navigate Sidewalks](https://arxiv.org/abs/2109.05603)
3. **做配对评估。** 固定路线和种子，分别跑理想、户外、湿滑预设与保留的真实路线。对照成功率、每公里碰撞或违规、人工接管次数，附上制动距离及传感器时间戳差分布。需要更接近实景的 RGB 时，SidewalkBench 提供实景扫描场景和可复现的交互用例，可作为单独的高保真评测入口。[SidewalkBench](https://vail.cs.ucla.edu/SidewalkBench/)
