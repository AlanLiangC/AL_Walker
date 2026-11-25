import { construction, crossings, crossingSignal, cycleLane, roads } from './city.mjs';
import { contains, distance } from './math.mjs';

export const OPEN_SPEED = 2;
export const CROSSING_SPEED = 1.35;

export const penalties = {
  'collision-car': { label:'与机动车碰撞', points:36, critical:true },
  'collision-bike': { label:'与骑行者碰撞', points:30, critical:true },
  'collision-pedestrian': { label:'与行人碰撞', points:38, critical:true },
  'collision-static': { label:'撞到障碍物', points:18, critical:true },
  'red-light': { label:'红灯进入斑马线', points:22, critical:true },
  'stop-sign': { label:'未按停牌要求停稳', points:16, critical:true },
  'guard-closed': { label:'护学横道开放前进入', points:20, critical:true },
  'loading-zone': { label:'闯入装卸作业区', points:22, critical:true },
  'unsafe-gap': { label:'来车过近时进入无灯横道', points:12, critical:false },
  jaywalk: { label:'未走斑马线，进入机动车道', points:24, critical:true },
  'work-zone': { label:'闯入施工禁行区', points:24, critical:true },
  'cycle-lane': { label:'占用非机动车道', points:8, critical:false },
  'no-yield': { label:'未减速礼让行人或骑行者', points:10, critical:false },
  speeding: { label:'超过该区域限速', points:6, critical:false },
};

function crossingAt({x,z}) {
  return crossings.find(area => contains(area,x,z));
}

export function checkRules(state, player, actors, dt) {
  const { x,z } = player;
  const previous = state.player;
  const crossing = crossingAt(player);
  const wasCrossing = crossingAt(previous);
  const road = roads.find(area => contains(area,x,z));
  const lane = contains(cycleLane,x,z) && !road && !crossing;
  const work = contains(construction,x,z);
  const speedLimit = crossing || lane ? CROSSING_SPEED : OPEN_SPEED;
  const travelYaw=player.yaw+(player.speed<0 ? Math.PI : 0);
  const sine=Math.sin(travelYaw),cosine=Math.cos(travelYaw);
  const yieldTarget = actors.some(actor => {
    if (!['pedestrian','bike','car','van'].includes(actor.kind)) return false;
    const deltaX = actor.x-x;
    const deltaZ = actor.z-z;
    const ahead = deltaX*sine-deltaZ*cosine;
    const lateral = Math.abs(deltaX*cosine+deltaZ*sine);
    if (ahead <= .15 || lateral > 1.1) return false;
    if (actor.kind === 'pedestrian' || actor.kind === 'bike') return Math.hypot(deltaX,deltaZ) < 2.6;
    return crossing?.id === 'local' && distance([x,z],[actor.x,actor.z]) < 3.5;
  });
  const conditions = {
    jaywalk:!!road && crossing?.road !== road.id,
    'work-zone':work,
    'cycle-lane':lane,
    'no-yield':yieldTarget && Math.abs(player.speed) > .9,
    speeding:Math.abs(player.speed) > speedLimit+.11,
  };
  if (crossing && crossing.id !== wasCrossing?.id && crossingSignal(state.time,crossing).state === 'stop') {
    state.penalize('red-light', crossing.name, player);
  }
  for (const [code,on] of Object.entries(conditions)) {
    const before = state.ruleExposure[code] ?? 0;
    const elapsed = on ? before+dt : 0;
    state.ruleExposure[code] = elapsed;
    const threshold = ({ speeding:.8,'no-yield':.38,'cycle-lane':.65 })[code] ?? dt;
    if (elapsed >= threshold && before < threshold) state.penalize(code, null, player);
  }
  return { speedLimit, yieldTarget, crossing:crossing?.id ?? null };
}
