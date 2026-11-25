import { OPEN_SPEED } from './rules.mjs';
import { contains, clamp } from './math.mjs';
import { benchmarkVersion, challengeVersion, findEpisode, scenarios } from './scene-families.mjs';
import { getUrbanScene } from './urban-scene.mjs';
import { trafficThreat, urbanSignal, urbanTraffic } from './urban-traffic.mjs';

const restrictionText={ 'work-zone':'围挡内施工区','loading-zone':'装卸作业区' };
const zoneDistance=(actor,box)=>Math.hypot(actor.x-clamp(actor.x,box.x1,box.x2),actor.z-clamp(actor.z,box.z1,box.z2));

function trackRule(engine,code,active,dt,threshold,player,detail) {
  const before=engine.ruleExposure[code]??0;
  const elapsed=active?before+dt:0;
  engine.ruleExposure[code]=elapsed;
  if (elapsed>=threshold&&before<threshold) engine.penalize(code,detail,player);
}

function incomingTraffic(crossing,actors) {
  const x=(crossing.x1+crossing.x2)/2,z=(crossing.z1+crossing.z2)/2;
  return actors.some(actor=>{
    if (actor.kind==='pedestrian'||actor.speed<=.55||zoneDistance(actor,crossing)>=1.20) return false;
    const toward=(x-actor.x)*Math.sin(actor.yaw)-(z-actor.z)*Math.cos(actor.yaw);
    return toward>-.4;
  });
}

function checkUrbanRules(engine,player,actors,dt) {
  const {world}=engine;
  const {x,z}=player;
  const inside=area=>contains(area,x,z);
  const crossing=world.crossings.find(inside);
  const road=world.layout.roads.find(inside);
  const lane=world.layout.cycleLanes.some(inside)&&!crossing;
  const restricted=world.layout.restricted.find(inside);
  const speedZone=world.layout.zones.find(inside);
  const speed=Math.abs(player.speed);
  const speedLimit=crossing?.speed ?? (lane ? 1.05 : speedZone?.speed ?? OPEN_SPEED);
  const approaching=world.crossings.find(c=>c.mode==='stop'&&zoneDistance(player,c)<1.8);
  if (approaching?.id!==engine.stopApproach?.id) engine.stopApproach=approaching?{id:approaching.id,hold:0,stopped:false}:null;
  const stop=engine.stopApproach;
  if (stop&&!crossing) {
    stop.hold=speed<.13 ? stop.hold+dt : 0;
    if (stop.hold>=.45) stop.stopped=true;
  }
  const before=world.crossings.find(c=>contains(c,engine.player.x,engine.player.z));
  if (crossing&&crossing.id!==before?.id) {
    const state=world.crossingSignal(engine.time,crossing).state;
    if (state==='stop') engine.penalize(crossing.mode==='guard'?'guard-closed':'red-light',crossing.name,player);
    if (state==='full-stop'&&!stop?.stopped) engine.penalize('stop-sign',crossing.name,player);
    if (state==='full-stop'&&stop) stop.stopped=false;
    if (state==='yield'&&incomingTraffic(crossing,actors)) {
      engine.penalize('unsafe-gap',crossing.name,player);
    }
  }
  const yieldTarget=trafficThreat(player,actors,world.scenario.streams?3.5:world.scenario.crowd?3.2:2.6);
  trackRule(engine,'jaywalk',!!road&&crossing?.road!==road.id,dt,dt,player,road?.name);
  for (const [code,detail] of Object.entries(restrictionText)) {
    trackRule(engine,code,restricted?.kind===code,dt,dt,player,detail);
  }
  trackRule(engine,'cycle-lane',lane,dt,.65,player,'沿道路设置的专用非机动车道');
  trackRule(engine,'no-yield',yieldTarget&&speed>.88,dt,.4,player);
  trackRule(engine,'speeding',speed>speedLimit+.10,dt,.70,player,crossing?.name??speedZone?.name);
  return { speedLimit,yieldTarget,crossing:crossing?.id??null,zone:speedZone?.name??null,
    stopReady:!!stop?.stopped };
}

function chooseChallengeRoute(layout,episode,scenario) {
  const ranked=layout.routes.map((route,index)=>({ route,index })).sort((a,b)=>{
    const score=item=>scenario.streams
      ? (item.points.length-item.crossings.length)*10+item.crossings.length*5+item.length*.07
      : item.crossings.length*17+item.length*.11;
    return score(b.route)-score(a.route);
  });
  return ranked[episode.seed%3];
}

export function urbanEpisode(episodeId,seedOverride) {
  const episode=findEpisode(episodeId);
  if (!episode) throw new RangeError('未知 Episode '+episodeId);
  const layout=getUrbanScene(episode.sceneId);
  const scenario=scenarios.find(item=>item.id===episode.scenario);
  const extreme=episode.difficulty==='extreme';
  const { route,index:routeIndex }=extreme ? chooseChallengeRoute(layout,episode,scenario)
    : { route:layout.routes[episode.routeIndex],index:episode.routeIndex };
  const seed=seedOverride??episode.seed;
  const phase=(seed%97)/5+(episode.scenario==='staggered'?9:0);
  const task={
    id:episodeId,name:scenario.name,from:'路点 '+String(route.start+1).padStart(2,'0'),to:'路点 '+String(route.goal+1).padStart(2,'0'),
    description:layout.name+'中的 '+Math.round(route.length)+' 米通行任务。',
    conditions:[...new Set(route.crossings.map(id=>layout.crossings.find(c=>c.id===id).name))].join(' · ')||'无机动车道穿越',
    limit:Math.ceil((route.length/1.04+route.crossings.length*26+11)*scenario.slack+(scenario.streams??0)*13),
    seed:episode.seed,points:route.points,
  };
  return {
    id:'urban',episode:{ ...episode,routeIndex },scenario,layout,tasks:[task],bounds:layout.bounds,colliders:layout.colliders,
    crossings:layout.crossings,surfaceAt:layout.surfaceAt,paved:()=>true,goalRadius:1.18,
    crossingSignal:(time,crossing)=>urbanSignal(time,crossing,phase),
    checkRules:checkUrbanRules,...urbanTraffic(layout,episode,scenario,seed,phase,route),
  };
}

export function describeUrbanEpisode(id) {
  const world=urbanEpisode(id);
  const task=world.tasks[0];
  const extension=world.episode.difficulty ? { challengeVersion,population:world.population } : {};
  return structuredClone({ ...world.episode,benchmarkVersion,...extension,points:task.points,length:world.layout.routes[world.episode.routeIndex].length,
    maxSeconds:task.limit,crossings:world.layout.routes[world.episode.routeIndex].crossings
      .map(id=>world.crossings.find(c=>c.id===id)),speedZones:world.layout.zones,restricted:world.layout.restricted });
}
