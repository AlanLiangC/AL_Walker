import { writeFileSync,mkdirSync,readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runEpisode } from '../reference-controller.mjs';
import { guidance } from '../../src/navigation.mjs';
import { episodeCatalog,challengeCatalog } from '../../src/scene-families.mjs';

const cases=JSON.parse(readFileSync(new URL('./cases.json',import.meta.url)));
const [destination,robotId='go2']=process.argv.slice(2);
if (!destination) throw Error('Usage: node tools/eden/replay.mjs OUTPUT_DIR [ROBOT_ID]');
mkdirSync(destination,{recursive:true});

for (const criteria of cases) {
  const episode=[...episodeCatalog,...challengeCatalog].find(row=>row.id===criteria.episodeId);
  const actions=[],truth=[];
  let eventTick=null;
  const final=runEpisode(episode.id,robotId,(engine,action)=>{
    actions.push(action);
    if (engine.ticks%5!==0) return;
    const { player,actors,time,world }=engine;
    const nav=guidance(engine.route,player,time,world.crossings,world.crossingSignal);
    const nearby=actors.flatMap(({id,kind,x,y,z,yaw,speed})=>{
      const distance=Math.hypot(x-player.x,z-player.z);
      return distance<=20?[{id,kind,x,y,z,yaw,speed,distance}]:[];
    });
    const signals=world.crossings.filter(crossing=>
      Math.hypot((crossing.x1+crossing.x2)/2-player.x,(crossing.z1+crossing.z2)/2-player.z)<=28)
      .map(crossing=>({id:crossing.id,position:[(crossing.x1+crossing.x2)/2,(crossing.z1+crossing.z2)/2],
        ...world.crossingSignal(time,crossing)}));
    truth.push({tick:engine.ticks,player:{ ...player },nearby,signals});
    if (eventTick===null) {
      const signal=criteria.focus==='signal'&&nav.signal?.distance<7&&nav.signal.state==='stop';
      const match=criteria.focus==='pedestrian'&&nearby.some(actor=>actor.kind==='pedestrian'&&actor.distance<5)||
        criteria.focus==='vehicle'&&nearby.filter(actor=>actor.kind!=='pedestrian'&&actor.distance<12).length>=2;
      if (signal||match) eventTick=engine.ticks;
    }
  });
  const duration=Math.min(1200,actions.length);
  const start=Math.max(0,Math.min((eventTick??0)-300,actions.length-duration));
  const end=start+duration;
  const plan={...criteria,config:{ episodeId:episode.id,robotId,seed:episode.seed,recordTrajectory:true },
    eventTick,start,end,actions:actions.slice(0,end),truth:truth.filter(row=>row.tick>=start&&row.tick<=end),
    referenceResult:{ status:final.status,score:final.score,events:final.events }};
  writeFileSync(join(destination,episode.id+'.json'),JSON.stringify(plan));
  console.log(episode.id,episode.seed,start*.05,end*.05,final.status);
}
