import { clamp, distance, intersects, randomSource } from './math.mjs';

const palette=['#c58758','#7e9bb1','#83958a','#d4c8b1','#ae776e','#8591a7'];
const center=c=>[(c.x1+c.x2)/2,(c.z1+c.z2)/2];
const streamOffsets=[-3,-2,-1,0,1,2,3];

export function urbanSignal(time,crossing,phase=0) {
  if (crossing.mode==='yield') return { state:'yield',remaining:null };
  if (crossing.mode==='stop') return { state:'full-stop',remaining:null };
  const period=crossing.mode==='guard' ? 31 : 36;
  const open=crossing.mode==='guard' ? 12 : 15;
  const t=(time+phase+crossing.phase)%period;
  if (t<open) return { state:'walk',remaining:open-t };
  return { state:'stop',remaining:period-t };
}

export function crossingYieldTime(time,crossing,phase) {
  if (!['signal','guard'].includes(crossing.mode)) return false;
  const period=crossing.mode==='guard'?31:36;
  const open=crossing.mode==='guard'?12:15;
  const t=(time+phase+crossing.phase)%period;
  return t<open+4 || t>period-3;
}

function motors(layout,episode,scenario,rand) {
  const result=[];
  for (const road of layout.roads) {
    const axis=road.axis==='h'?0:1;
    const small=axis===0?layout.bounds.x1:layout.bounds.z1;
    const large=axis===0?layout.bounds.x2:layout.bounds.z2;
    const entries=layout.crossings.filter(c=>c.road===road.id);
    const runs=[-1,1].map(dir=>[dir,road.center+dir*road.width*.25,'car']);
    if (road.cycle) runs.push([1,axis===0?(road.cycle.z1+road.cycle.z2)/2:(road.cycle.x1+road.cycle.x2)/2,'bike']);
    for (const [dir,lane,kind] of runs) {
      const start=dir===1?small-8:large+8;
      const length=large-small+16;
      const vehicle=kind==='car'&&(layout.family.facility==='transit'||episode.scenario==='courier'||rand()>.72)?'van':kind;
      const gap=vehicle==='van'?4.9:vehicle==='bike'?2.8:4.45;
      const stops=entries.map(crossing => {
        const progress=(center(crossing)[axis]-start)*dir;
        return { crossing,at:progress-gap,cleared:progress+gap };
      });
      const speed=(vehicle==='bike'?3.1:layout.family.edge==='narrow'?3.8:5.2)*(.87+rand()*.27);
      const track={ id:'line-'+road.id+'-'+result.length,kind:vehicle,axis,start,dir,lane,length,speed,stops,
        color:palette[result.length%palette.length],initial:rand()*Math.min(22,length*.22),gap };
      if (scenario.queueSize&&vehicle!=='bike') {
        const count=scenario.queueSize;
        const key=track.id;
        for (let n=0;n<count;n++) result.push({
          ...track,id:key+'-queue-'+n,leader:key+'-queue-'+(n+1)%count,
          initial:(track.initial+n*length/count)%length,
          color:palette[(n+result.length)%palette.length],speed:speed*(.66+rand()*.31),
        });
        continue;
      }
      result.push(track);
      if (scenario.density*layout.variant.traffic>1.34 && vehicle!=='bike') {
        result.push({ ...track,id:track.id+'-following',leader:track.id,initial:track.initial-length*.27,
          color:palette[(result.length+2)%palette.length],speed:speed*.89 });
      }
    }
  }
  return result;
}

function walkers(layout,scenario,rand) {
  const paths=layout.edges.filter(e=>!e.crossing);
  const count=Math.round((layout.family.edge==='crowd'?6:layout.family.edge==='shared'?5:3)*scenario.density);
  const result=[];
  const sideDistance=scenario.crowd?1.33:1.6;
  for (let i=0;i<count&&paths.length;i++) {
    const fromIndex=Math.floor(rand()*paths.length);
    const [edge]=paths.splice(fromIndex,1);
    const a=layout.nodes[edge.from],b=layout.nodes[edge.to];
    const axis=a.x===b.x?1:0;
    const kind=layout.family.edge==='shared'&&i===0 ? 'bike' : 'pedestrian';
    const dir=i%2===0?1:-1;
    const lane=(axis===0?a.z:a.x)+(i%2===0?1:-1)*(kind==='bike'?1.8:sideDistance);
    const lo=(axis===0?a.x:a.z)+3.8;
    const hi=(axis===0?b.x:b.z)-3.8;
    const length=hi-lo;
    const initial=rand()*length;
    result.push({ id:'walk-'+i,kind,axis,start:dir===1?lo:hi,dir,lane,length,initial,
      color:palette[(i+3)%palette.length],speed:(kind==='bike'?2.55:.86)+rand()*.42,stops:[],bounce:true });
  }
  return result;
}

function crossingStreams(layout,route,count,random) {
  const result=[];
  for (let i=1;i<route.points.length&&result.length<count*streamOffsets.length;i++) {
    const [x1,z1]=route.points[i-1],[x2,z2]=route.points[i];
    const alongX=z1===z2,x=(x1+x2)/2,z=(z1+z2)/2;
    const centerLine=alongX?x:z;
    const base=alongX?z:x;
    if (layout.roads.some(r=>x>r.x1-3&&x<r.x2+3&&z>r.z1-3&&z<r.z2+3)) continue;
    const safe=streamOffsets.every(offset=>[-2.15,-1,0,1,2.15].every(side=>
      !layout.colliders.some(c=>intersects(c,alongX?x+offset:x+side,alongX?z+side:z+offset,.41))));
    if (!safe) continue;
    const group=result.length/streamOffsets.length;
    streamOffsets.forEach((offset,j)=>{
      const dir=(j+i)%2===0?1:-1;
      const rest=1.2+random()*2.4;
      const initial=j%3===0 ? .3+random()*.88 : -(j%3)*rest;
      const lane=centerLine+offset+(random()-.5)*.24;
      result.push({ id:'flow-'+group+'-'+j,kind:'pedestrian',axis:alongX?1:0,
        start:base-dir*2.15,lane,dir,length:4.30,bounce:true,stream:true,
        initial,rest,stops:[],color:palette[(group+j)%palette.length],speed:.78+random()*.40 });
    });
  }
  return result;
}

function place(track,progress,speed) {
  const offset=track.bounce&&progress>track.length ? track.length*2-progress : track.stream?Math.max(0,progress):progress;
  const distanceAlong=track.start+track.dir*offset;
  const dir=track.bounce&&progress>track.length?-track.dir:track.dir;
  const [x,z]=track.axis===0?[distanceAlong,track.lane]:[track.lane,distanceAlong];
  return { id:track.id,kind:track.kind,color:track.color,x,z,y:0,
    yaw:track.axis===0?dir*Math.PI/2:dir===1?Math.PI:0,progress,speed };
}

function distanceToArea(player,area) {
  return Math.hypot(player.x-clamp(player.x,area.x1,area.x2),player.z-clamp(player.z,area.z1,area.z2));
}

export function urbanTraffic(layout,episode,scenario,seed,phase,route) {
  const rand=randomSource(seed^0x8cffc7);
  const tracks=[...motors(layout,episode,scenario,rand),...walkers(layout,scenario,rand),
    ...crossingStreams(layout,route,scenario.streams??0,rand)];
  const indexes=new Map(tracks.map((track,i)=>[track.id,i]));
  return {
    population:{
      pedestrians:tracks.filter(t=>t.kind==='pedestrian').length,
      vehicles:tracks.filter(t=>t.kind==='car'||t.kind==='van').length,
      cyclists:tracks.filter(t=>t.kind==='bike').length,
      pedestrianStreams:tracks.filter(t=>t.stream).length/streamOffsets.length,
    },
    createTraffic:()=>tracks.map(t=>place(t,t.initial,t.initial>=0?t.speed:0)),
    advanceTraffic:(actors,player,time,dt,domain)=>actors.map((actor,index)=>{
      const track=tracks[index];
      const speed=track.speed*(1-domain.wet*.20);
      let next=actor.progress+speed*dt;
      if (track.bounce) {
        if (track.stream&&next>0) {
          const along=track.axis===0?player.x:player.z;
          const lateral=track.axis===0?player.z:player.x;
          const ahead=along-(track.axis===0?actor.x:actor.z);
          const direction=actor.progress>track.length?-track.dir:track.dir;
          if (direction*ahead>0&&direction*ahead<1.16&&Math.abs(lateral-track.lane)<.89) next=actor.progress;
        }
        if (next>=track.length*2) next=track.stream?-track.rest:next-track.length*2;
      } else {
        for (const {crossing,at} of track.stops) {
          if (actor.progress>at+1e-6) continue;
          const nearby=distanceToArea(player,crossing)<2.7;
          if (nearby||crossingYieldTime(time,crossing,phase)) next=Math.min(next,at);
        }
        if (track.leader) {
          const leader=actors[indexes.get(track.leader)];
          const ahead=(leader.progress-actor.progress+track.length)%track.length;
          if (ahead<7.2 && leader.progress>=0) next=Math.min(next,actor.progress+Math.max(0,ahead-5.9));
        }
        if (next>track.length) next-=track.length;
      }
      const period=track.length*(track.bounce?2:1);
      const traveled=track.stream ? Math.max(0,Math.max(0,next)-Math.max(0,actor.progress))
        : Math.max(0,next-actor.progress+(next<actor.progress-1e-5?period:0));
      return place(track,next,traveled/dt);
    }),
  };
}

export function trafficThreat(player,actors,range=2.5) {
  const yaw=player.yaw+(player.speed<0?Math.PI:0);
  const f=[Math.sin(yaw),-Math.cos(yaw)];
  return actors.some(actor=>{
    if (actor.kind!=='pedestrian'&&actor.kind!=='bike') return false;
    const dx=actor.x-player.x,dz=actor.z-player.z;
    return dx*f[0]+dz*f[1]>.06 && Math.abs(dx*f[1]-dz*f[0])<.95 && distance([0,0],[dx,dz])<range;
  });
}
