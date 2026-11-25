import { clamp, contains } from './math.mjs';

export const box = (x1, z1, x2, z2) => ({ x1, z1, x2, z2 });
export const bounds = box(-65, -56, 65, 55);
export const GOAL_RADIUS = 1.45;
export const roads = [
  { ...box(-65, -6, 65, 6), id: 'eastWest', name: '滨河大道' },
  { ...box(-6, -56, 6, 55), id: 'northSouth', name: '中轴路' },
  { ...box(37.8, -56, 44.2, -10), id: 'local', name: '青石巷' },
];
export const sidewalks = [
  box(-65,-9,-6,-6), box(6,-9,65,-6), box(-65,7.25,-6,10), box(6,7.25,65,10),
  box(-9,-56,-6,-6), box(6,-56,9,-6), box(-9,6,-6,55), box(6,6,9,55),
  box(35.8,-56,37.8,-10), box(44.2,-56,46.2,-10),
];
export const cycleLane = box(-65, 6, 65, 7.25);
export const construction = box(24, 10.8, 48, 28);
export const pond = box(-51, 24, -35, 37);
export const ramp = box(48, 34, 56, 39);
export const terrace = box(47, 39, 60, 50);
export const plazas = [box(11,28,61,35), box(11,10,22,35), box(47,34,60,50), box(16,-27,34,-17)];
export const park = box(-61, 11, -11, 48);
export const parkPaths = [box(-60,16,-13,19), box(-32,11,-28,47), box(-58,39,-16,42)];
export const localWalk = box(33, -15, 61, -10);
export const landmarks = [
  { x:-42, z:22, name:'河湾公园' },
  { x:-42, z:-20, name:'中心图书馆' },
  { x:23, z:-29, name:'青石商业街' },
  { x:-28, z:17, name:'滨河公交站' },
  { x:53, z:46, name:'社区广场' },
  { x:55, z:13, name:'社区东门' },
  { x:53, z:-18, name:'社区诊所' },
];

export const crossings = [
  { ...box(-14.7,-6,-11.3,7.25), id:'west', road:'eastWest', name:'西侧信控斑马线' },
  { ...box(11.3,-6,14.7,7.25), id:'east', road:'eastWest', name:'东侧信控斑马线' },
  { ...box(-6,-14.7,6,-11.3), id:'north', road:'northSouth', name:'北侧信控斑马线' },
  { ...box(-6,11.3,6,14.7), id:'south', road:'northSouth', name:'南侧信控斑马线' },
  { ...box(37.8,-15,44.2,-11.7), id:'local', road:'local', name:'青石巷无灯斑马线' },
];

export const buildings = [
  { ...box(-61,-45,-48,-17), height:15, color:'#9ba9ad', sign:'CITY LIBRARY' },
  { ...box(-43,-48,-30,-24), height:23, color:'#8b9ba5' },
  { ...box(-26,-47,-14,-21), height:14, color:'#a09380' },
  { ...box(-42,-19,-23,-11.5), height:8, color:'#bdac94' },
  { ...box(13,-49,24,-32), height:25, color:'#889da4' },
  { ...box(27,-44,35,-29), height:17, color:'#bac1b9' },
  { ...box(15,-24,28,-19), height:9, color:'#b09a7f', sign:'QINGSHI MARKET' },
  { ...box(47,-51,62,-32), height:19, color:'#94a6ab' },
  { ...box(49,-29,63,-17), height:8, color:'#d2c3ad', sign:'COMMUNITY CLINIC' },
  { ...box(-63,23,-55,29), height:4.2, color:'#8c9b90' },
  { ...box(-62,48,-44,54), height:12, color:'#9ba7a2' },
  { ...box(59,13,64,29), height:13, color:'#a6afb0' },
  { ...box(27,41,39,53), height:11, color:'#b8a994' },
  { ...box(17,42,23,53), height:8, color:'#9ba9a6' },
];

export const trees = [
  [-59,12],[-53,15],[-45,14],[-37,13],[-43,20],[-53,23],[-56,34],[-32,22],
  [-21,27],[-15,22],[-14,35],[-22,44],[-36,45],[-54,44],[-10.4,20],[-10.5,35],
  [-20,-10.6],[-29,-10.8],[-57,-10.5],[-47,-11.4],[-11,-20],[-11,-33],
  [18,-11],[33,-10.5],[48,-11.1],[62,-9.9],[53,13],[58,38],[58,48],[49,48],
  [20,38],[14.5,46],[11.5,21],[63,38],[52,-43],[31,-48],
];
export const furniture = [
  { ...box(-31.8,10.03,-25.5,11.15), kind:'shelter', height:2.8 },
  { ...box(-38.7,-11.14,-34.35,-9.30), kind:'parked-car',height:1.47,color:'#697582' },
  { ...box(-35,18.9,-32.9,19.45), kind:'bench', height:.8 },
  { ...box(-51,39,-48.9,39.55), kind:'bench', height:.8 },
  { ...box(47.3,43,48,45), kind:'bench', height:.8 },
  { ...box(55,43,57,45), kind:'planter', height:.7 },
  { ...box(16.2,-11,18.2,-10.25), kind:'planter', height:.6 },
  { ...box(45.5,-16,46.1,-15.4), kind:'bin', height:1.0 },
  { ...box(24,16.6,24.38,27.9), kind:'barrier', height:1.05 },
  { ...box(24,27.65,48,28.05), kind:'barrier', height:1.05 },
  { ...box(47.65,11,48,28), kind:'barrier', height:1.05 },
  { ...box(24,10.9,48,11.25), kind:'barrier', height:1.05 },
  { ...box(31,15,39,21), kind:'container', height:2.65 },
  { ...box(42,18,45,22), kind:'container', height:1.5 },
  { ...box(20.2,28.7,21.0,29.5), kind:'cone', height:.68 },
  { ...box(22.4,28.4,23.2,29.2), kind:'cone', height:.68 },
];

export const lightPoles = [
  { x:-15.7, z:-9.35, crossing:'west' }, { x:-10.4, z:8.6, crossing:'west' },
  { x:10.4, z:-7.8, crossing:'east' }, { x:15.7, z:8.6, crossing:'east' },
  { x:-7.9, z:-15.8, crossing:'north' }, { x:7.9, z:-10.3, crossing:'north' },
  { x:7.9, z:15.8, crossing:'south' }, { x:-7.9, z:10.3, crossing:'south' },
];
export const streetLamps = [
  [-55,9.73],[-40,9.73],[-22,9.73],[24,9.73],[40,9.73],[57,9.73],
  [-55,-8.8],[-36,-8.8],[-22,-8.8],[22,-8.8],[36,-8.8],[55,-8.8],
  [8.75,-32],[8.75,-47],[-8.75,28],[8.75,31],[8.75,49],
];

export const tasks = [
  {
    id:'riverside', name:'滨河通勤', from:'河湾公园西口', to:'社区广场',
    description:'沿滨河大道步行，经南侧斑马线穿过中轴路，从围挡外侧绕行至广场坡道。',
    conditions:'信控路口 · 公交站 · 施工绕行 · 无障碍坡道', limit:170, seed:81,
    points:[[-49,8.6],[-12.9,8.6],[-12.9,13],[-8,13],[8,13],[13,13],[13,32],[52,32],[52,45]],
  },
  {
    id:'market', name:'青石巷巡检', from:'图书馆东侧', to:'社区诊所',
    description:'沿图书馆人行道向北，经北侧信控斑马线与青石巷无灯斑马线前往诊所。',
    conditions:'信控路口 · 无灯斑马线 · 社区车辆', limit:120, seed:36,
    points:[[-37,-7.8],[-13,-7.8],[-13,-13],[-8,-13],[8,-13],[54,-13]],
  },
  {
    id:'library', name:'公交接驳', from:'滨河公交站', to:'图书馆南门',
    description:'从站台出发，经西侧斑马线穿过滨河大道，沿北侧人行道抵达图书馆。',
    conditions:'公交候车行人 · 非机动车道 · 信控路口', limit:110, seed:59,
    points:[[-28,8.55],[-13,8.55],[-13,-7.85],[-45,-7.85],[-45,-15]],
  },
  {
    id:'detour', name:'施工区绕行', from:'青石商业街', to:'社区东门',
    description:'穿过东侧信控斑马线，从围挡南侧绕行，再向北抵达社区东门。',
    conditions:'人群 · 非机动车道 · 施工围挡', limit:155, seed:103,
    points:[[31,-17],[31,-8],[13,-8],[13,8.5],[13,32],[52,32],[52,15]],
  },
];

export function surfaceAt(x, z) {
  if (contains(terrace, x, z)) return .7;
  if (contains(ramp, x, z)) return clamp((z - ramp.z1) / (ramp.z2 - ramp.z1), 0, 1) * .7;
  if (contains(pond, x, z)) return -.2;
  const sidewalk = sidewalks.some(area => contains(area, x, z));
  const road = roads.some(area => contains(area, x, z));
  if (sidewalk && !road) {
    for (const crossing of crossings) {
      const along = crossing.road === 'eastWest' ? x : z;
      const spanMin = crossing.road === 'eastWest' ? crossing.x1 : crossing.z1;
      const spanMax = crossing.road === 'eastWest' ? crossing.x2 : crossing.z2;
      if (along < spanMin || along > spanMax) continue;
      const axis = crossing.road === 'eastWest' ? z : x;
      const lower = crossing.road === 'eastWest' ? crossing.z1 : crossing.x1;
      const upper = crossing.road === 'eastWest' ? crossing.z2 : crossing.x2;
      const edgeDistance = Math.max(lower - axis, axis - upper);
      if (edgeDistance < .85) return .14 * clamp(edgeDistance / .85, 0, 1);
    }
    return .14;
  }
  return 0;
}

export const colliders = [
  ...buildings.map(item => ({ ...item, y:0, kind:'building' })),
  ...furniture.map(item => ({ ...item, y:surfaceAt((item.x1+item.x2)/2, (item.z1+item.z2)/2) })),
  ...trees.flatMap(([x,z]) => [
    { ...box(x-.2,z-.2,x+.2,z+.2), y:0, height:2.7, kind:'tree' },
    { ...box(x-1.65,z-1.65,x+1.65,z+1.65), y:2.7, height:2.9, kind:'canopy', solid:false },
  ]),
  ...[...lightPoles.map(({x,z}) => [x,z]), ...streetLamps].map(([x,z]) =>
    ({ ...box(x-.11,z-.11,x+.11,z+.11), y:surfaceAt(x,z), height:4.3, kind:'pole' })),
  { ...pond, y:-.2, height:.18, kind:'water' },
].map((item, id) => ({ ...item, id:'static-' + id }));

export function signalAt(time, road) {
  if (road === 'local') return { state:'yield', remaining:null };
  const phase = ((time % 42) + 42) % 42;
  const start = road === 'eastWest' ? 0 : 21;
  const elapsed = (phase - start + 42) % 42;
  if (elapsed < 16) return { state:'green', remaining:16-elapsed };
  if (elapsed < 19) return { state:'amber', remaining:19-elapsed };
  return { state:'red', remaining:42-elapsed };
}

export function crossingSignal(time, crossing) {
  if (crossing.road === 'local') return { state:'yield', remaining:null };
  const start = crossing.road === 'eastWest' ? 21 : 0;
  const elapsed = ((time - start) % 42 + 42) % 42;
  return elapsed < 16
    ? { state:'walk', remaining:16-elapsed }
    : { state:'stop', remaining:42-elapsed };
}
