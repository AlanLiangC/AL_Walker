import { CityEngine } from '../src/engine.mjs';
import { clamp, contains, heading, wrap } from '../src/math.mjs';

function segmentCrossings(route,world) {
  return route.segments.map(segment=>{
    const [a,b]=segment.from,[u,v]=segment.to;
    const horizontal=b===v;
    return world.crossings.filter(c=>{
      const x=(c.x1+c.x2)/2,z=(c.z1+c.z2)/2;
      return horizontal ? Math.abs(z-b)<.25&&x>Math.min(a,u)&&x<Math.max(a,u)
        : Math.abs(x-a)<.25&&z>Math.min(b,v)&&z<Math.max(b,v);
    });
  });
}

function crossingOccupied(c,actors) {
  const horizontalRoad=c.x2-c.x1<c.z2-c.z1;
  return actors.some(actor=>{
    if (actor.kind==='pedestrian') return false;
    const extent=actor.kind==='van'?4.19:actor.kind==='bike'?2.28:3.91;
    if (horizontalRoad) {
      return actor.z>=c.z1-.3&&actor.z<=c.z2+.3
        &&Math.abs(actor.x-(c.x1+c.x2)/2)<extent;
    }
    return actor.x>=c.x1-.3&&actor.x<=c.x2+.3
      &&Math.abs(actor.z-(c.z1+c.z2)/2)<extent;
  });
}

function crowdAhead(player,actors,course,range,halfWidth) {
  const [x,z]=course;
  return actors.some(actor=>{
    if (!actor.id.startsWith('flow-')) return false;
    const dx=actor.x-player.x,dz=actor.z-player.z;
    const along=dx*x+dz*z;
    if (along<.3||along>range) return false;
    const side=dz*x-dx*z;
    const projected=side-actor.speed*(Math.cos(actor.yaw)*x+Math.sin(actor.yaw)*z)*.95;
    return Math.min(side,projected)<halfWidth&&Math.max(side,projected)>-halfWidth;
  });
}

function routeAction(engine,segment,crossings) {
  const { player:p,world,domain,robot }=engine;
  const distance=Math.hypot(segment.to[0]-p.x,segment.to[1]-p.z);
  const delta=wrap(heading([p.x,p.z],segment.to)-p.yaw);
  let desired=Math.min(1.54,Math.max(.22,distance*1.85));
  const course=[Math.sin(segment.yaw),-Math.cos(segment.yaw)];
  const look=[p.x+course[0]*1.35,p.z+course[1]*1.35];
  const zone=world.layout.zones.find(z=>contains(z,p.x,p.z)||contains(z,...look));
  if (zone) desired=Math.min(desired,zone.speed-.092);
  let wait=false;
  for (const c of crossings) {
    const horizontal=Math.abs(course[0])>.5;
    const along=horizontal?p.x:p.z;
    const dir=horizontal?course[0]:course[1];
    const [minimum,maximum]=horizontal?[c.x1,c.x2]:[c.z1,c.z2];
    const ahead=dir>0?minimum-along:along-maximum;
    const after=dir>0?along-maximum:minimum-along;
    if (after>.4||ahead>3) continue;
    desired=Math.min(desired,c.speed-.09);
    if (ahead<=0) continue;
    const signal=world.crossingSignal(engine.time,c);
    if (ahead<1.15&&signal.state==='full-stop'&&!engine.context.stopReady) wait=true;
    if (ahead<1.2&&(signal.state==='stop'||signal.state==='walk'&&signal.remaining<1.55)) wait=true;
    if (ahead<1.35&&crossingOccupied(c,engine.actors)) wait=true;
  }
  if (engine.context.yieldTarget) desired=Math.min(desired,.73);
  if (world.scenario.streams) {
    if (crowdAhead(p,engine.actors,course,5.5,2.6)) desired=Math.min(desired,.66);
    if (crowdAhead(p,engine.actors,course,1.15+Math.max(0,p.speed)*.76,robot.radius+.41)) wait=true;
  }
  const brake=wait||Math.abs(delta)>.52;
  const turn=(delta*(domain.field?1.95:6)-p.yawRate*(domain.field?.31:0))/robot.turn;
  return { brake, throttle:brake?0:desired/(robot.speed*domain.speedGain),turn:clamp(turn,-1,1) };
}

export function runEpisode(episodeId,robotId,onStep) {
  const engine=new CityEngine({ episodeId,robotId,sensors:[] });
  const {route,world}=engine;
  const crossings=segmentCrossings(route,world);
  let i=0;
  while (engine.status==='running') {
    const p=engine.player;
    const segment=route.segments[i];
    if (Math.hypot(segment.to[0]-p.x,segment.to[1]-p.z)<.19&&i<route.segments.length-1) {
      i++;
      continue;
    }
    const action=routeAction(engine,segment,crossings[i]);
    onStep?.(engine,action);
    engine.advanceSteps(action);
  }
  return engine.snapshot();
}
