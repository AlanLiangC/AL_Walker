import { box } from './city.mjs';
import { clamp, distance, randomSource } from './math.mjs';
import { findScene, sceneFamilies, sceneVariants } from './scene-families.mjs';

const cols=5,rows=4;
const types={
  signal:{ name:'信控斑马线', speed:1.25 },
  yield:{ name:'无灯礼让横道', speed:1.10 },
  stop:{ name:'停牌横道', speed:1.12 },
  guard:{ name:'学区护学横道', speed:1.05 },
};
const facilityNames={ commercial:'街区商铺',school:'教学楼',transit:'候车站',works:'作业场',
  park:'绿地步道',water:'亲水平台',market:'市集广场',clinic:'门诊入口' };
const zoneNames={
  school:['学区慢行',1.0],transit:['换乘候车区',1.1],clinic:['门诊落客区',1.08],
  crowd:['市集慢行',.95],shared:['共享步行区',1.12],loading:['装卸通道',1.15],
  park:['公园步道',1.25],
};

const cache=new Map();
const id=(i,j)=>j*cols+i;
const rect=(x,z,w,d)=>box(x-w/2,z-d/2,x+w/2,z+d/2);
const pick=(items,rand)=>items[Math.floor(rand()*items.length)];

function buildRoads(family,xs,zs,bounds,index) {
  const roads=[];
  const width=family.edge==='narrow' ? 4.7 : family.edge==='bike' ? 7.4 : 6.3;
  for (const [axis,dividers,cuts] of [['h',family.h,zs],['v',family.v,xs]]) {
    for (const original of dividers) {
      // Some variants move the trunk roads instead of simply resizing the blocks.
      const k=(original+(index===2||index===6 ? 1 : 0))%(cuts.length-1);
      const center=(cuts[k]+cuts[k+1])/2;
      const span=width*(.92+.04*(index%5));
      const area=axis==='h'?box(bounds.x1,center-span/2,bounds.x2,center+span/2)
        : box(center-span/2,bounds.z1,center+span/2,bounds.z2);
      const bike=family.edge==='bike'||family.id==='boulevard'&&index%3===1;
      const side=k%2===0?1:-1;
      const edge=center+side*span/2;
      const cycle=bike ? (axis==='h' ? box(bounds.x1,Math.min(edge,edge+side*1.38),bounds.x2,Math.max(edge,edge+side*1.38))
        : box(Math.min(edge,edge+side*1.38),bounds.z1,Math.max(edge,edge+side*1.38),bounds.z2)) : null;
      roads.push({ ...area,id:axis+k,axis,divider:k,center,width:span,cycle,
        name:(axis==='h'?'东西向':'南北向')+(family.edge==='narrow'?'支巷':'道路') });
    }
  }
  return roads;
}

function crosswalk(road,position,mode,key) {
  const lane=road.cycle;
  const area=road.axis==='h'
    ? box(position-1.68,lane?Math.min(lane.z1,road.z1):road.z1,position+1.68,lane?Math.max(lane.z2,road.z2):road.z2)
    : box(lane?Math.min(lane.x1,road.x1):road.x1,position-1.68,lane?Math.max(lane.x2,road.x2):road.x2,position+1.68);
  return { ...area,id:key,road:road.id,mode,phase:(Math.floor(position+100)*7+road.divider*5)%13,
    ...types[mode] };
}

function network(family,variant,xs,zs,roads,scene) {
  const nodes=zs.flatMap((z,j)=>xs.map((x,i)=>({ index:id(i,j),x,z })));
  const edges=[],crossings=[],barriers=[],restricted=[];
  const num=scene.variant-1;

  function connect(i,j,direction) {
    const h=direction==='h';
    const a=nodes[id(i,j)],b=nodes[id(i+Number(h),j+Number(!h))];
    const road=roads.find(r=>h ? r.axis==='v'&&r.divider===i : r.axis==='h'&&r.divider===j);
    const key=direction+i+'-'+j;
    const blocked=variant.blocked.includes(key)||(family.edge==='works'&&key==='v4-1')||
      (family.edge==='shared'&&num%2===0&&key==='h3-1');
    if (blocked) {
      const x=h ? (road?road.x1-2.1:(a.x+b.x)/2) : a.x;
      const z=h ? a.z : (road?road.z1-2.1:(a.z+b.z)/2);
      barriers.push({ ...rect(x,z,h?.48:4.3,h?4.3:.48),kind:'barrier',height:1.17,color:'#bc7849' });
      if (family.edge==='works'||family.edge==='loading') {
        restricted.push({ ...rect(x,z,h?3.4:5.2,h?5.2:3.4),kind:family.edge==='works'?'work-zone':'loading-zone' });
      }
      return;
    }
    const mode=road && family.modes[(i+j+num+(variant.crossing==='alternate'?j:0))%family.modes.length];
    const crossing=road ? crosswalk(road,h?a.z:a.x,mode,key) : null;
    if (crossing) crossings.push(crossing);
    edges.push({ from:a.index,to:b.index,crossing,
      cost:Math.hypot(a.x-b.x,a.z-b.z)+(crossing?(mode==='signal'?9:mode==='guard'?10:4):0) });
  }

  for (let j=0;j<rows;j++) for (let i=0;i<cols;i++) {
    if (i+1<cols) connect(i,j,'h');
    if (j+1<rows) connect(i,j,'v');
  }
  return { nodes,edges,crossings,barriers,restricted };
}

function makeRoutes(nodes,edges,seed) {
  const random=randomSource(seed^0x52173);
  const paths=[];
  const links=nodes.map(()=>[]);
  for (const edge of edges) {
    links[edge.from].push({ node:edge.to,edge });
    links[edge.to].push({ node:edge.from,edge });
  }
  for (const start of nodes) {
    const costs=nodes.map(()=>Infinity);
    const last=nodes.map(()=>null);
    const unvisited=new Set(nodes.map(n=>n.index));
    costs[start.index]=0;
    while (unvisited.size) {
      let current=null;
      for (const node of unvisited) if (current===null||costs[node]<costs[current]) current=node;
      if (!Number.isFinite(costs[current])) break;
      unvisited.delete(current);
      for (const {node,edge} of links[current]) {
        const cost=costs[current]+edge.cost;
        if (cost<costs[node]) { costs[node]=cost; last[node]={ current,edge }; }
      }
    }
    for (const goal of nodes) {
      if (!Number.isFinite(costs[goal.index])||costs[goal.index]<34||costs[goal.index]>151) continue;
      const chain=[],crossings=[];
      let index=goal.index;
      while (index!==start.index) {
        chain.unshift([nodes[index].x,nodes[index].z]);
        const step=last[index];
        if (step.edge.crossing) crossings.unshift(step.edge.crossing.id);
        index=step.current;
      }
      chain.unshift([start.x,start.z]);
      const length=chain.slice(1).reduce((sum,p,i)=>sum+distance(chain[i],p),0);
      paths.push({ start:start.index,goal:goal.index,points:chain,crossings,length,order:random() });
    }
  }

  // Stratify by crossing count, and distribute starts and goals through each bucket.
  const buckets=[0,1,2,3].map(n=>paths.filter(path=>Math.min(path.crossings.length,3)===n)
    .sort((a,b)=>a.order-b.order)).filter(paths=>paths.length);
  const routes=[];
  const starts=new Map(),goals=new Map();
  for (let i=0;i<20;i++) {
    const pool=buckets[i%buckets.length];
    if (!pool.length) continue;
    const quality=path=>((starts.get(path.start)??0)*2+(goals.get(path.goal)??0)*2+path.order);
    const best=pool.reduce((a,b)=>quality(b)<quality(a)?b:a);
    pool.splice(pool.indexOf(best),1);
    starts.set(best.start,(starts.get(best.start)??0)+1);
    goals.set(best.goal,(goals.get(best.goal)??0)+1);
    routes.push(best);
  }
  if (routes.length<20) {
    for (const path of paths) {
      if (!routes.includes(path)) routes.push(path);
      if (routes.length===20) break;
    }
  }
  if (routes.length!==20) throw new Error('场景缺少可达路线');
  return routes;
}

function scenery(family,scene,xs,zs,roads,bounds,network,rand) {
  const buildings=[],trees=[],props=[],water=[],zones=[];
  for (let j=0;j<rows-1;j++) for (let i=0;i<cols-1;i++) {
    const mx=(xs[i]+xs[i+1])/2,mz=(zs[j]+zs[j+1])/2;
    const open=i===(scene.variant+j)%4;
    for (const dx of [-1,1]) for (const dz of [-1,1]) {
      const x=mx+dx*(xs[i+1]-xs[i])*.26,z=mz+dz*(zs[j+1]-zs[j])*.26;
      const width=4.1+rand()*4.7,depth=4.0+rand()*4.1;
      const area=rect(x,z,width,depth);
      const overlapsRoad=roads.some(r=>{
        const c=r.cycle??r;
        return area.x1<Math.max(r.x2,c.x2)+.45&&area.x2>Math.min(r.x1,c.x1)-.45
          &&area.z1<Math.max(r.z2,c.z2)+.45&&area.z2>Math.min(r.z1,c.z1)-.45;
      });
      const walkwayClearance=2.1;
      const overlapsWalkway=xs.some(p=>area.x1-walkwayClearance<p&&area.x2+walkwayClearance>p)
        || zs.some(p=>area.z1-walkwayClearance<p&&area.z2+walkwayClearance>p);
      if (overlapsRoad||overlapsWalkway) continue;
      if (!open&&rand()*10<family.density) {
        buildings.push({ ...area,kind:'building',height:family.edge==='narrow'?4+rand()*6:5+rand()*(11+family.density),
          color:pick([family.color,'#b9ad9a','#889ba4','#cabba7','#a1aaa2'],rand),storefront:rand()>.54 });
      } else if (family.facility==='water'&&j===2&&dx===1&&dz===1) {
        water.push({ ...area,kind:'water',height:.3 });
      } else if (family.facility==='works'&&j===1&&dx===1&&dz===1) {
        props.push({ ...rect(x,z,4,2.7),kind:'container',height:2.35,color:'#a45135' });
      } else {
        trees.push({ ...rect(x,z,.52,.52),x,z,kind:'tree',height:3.0,scale:.72+rand()*.54 });
        if (family.density<5) trees.push({ ...rect(x+1.45,z+1.15,.36,.36),x:x+1.45,z:z+1.15,kind:'tree',height:2.6,scale:.66+rand()*.42 });
      }
    }
  }
  for (const node of network.nodes) {
    const x=node.x+3.3,z=node.z+3.3;
    const kind=family.facility==='transit' ? 'shelter' : family.facility==='market'?'stall':rand()>.55?'bench':'planter';
    if ((node.index+scene.variant)%3===0) {
      const width=kind==='shelter'?3.0:1.85,depth=kind==='stall'?1.65:1.0;
      props.push({ ...rect(x,z,width,depth),kind,height:kind==='shelter'||kind==='stall'?2.5:.7,color:family.color });
    }
    if (zoneNames[family.edge]&&((node.index+scene.variant)%3!==0)) {
      const [name,speed]=zoneNames[family.edge];
      zones.push({ ...rect(node.x,node.z,9.5,8.4),name,speed,kind:family.edge });
    }
  }
  if (family.facility==='water') {
    water.push({ ...box(bounds.x1,zs.at(-1)+4,bounds.x2,bounds.z2),kind:'water',height:.3 });
  }
  return { buildings,trees,props,water,zones };
}

export function getUrbanScene(sceneId) {
  if (cache.has(sceneId)) return cache.get(sceneId);
  const scene=findScene(sceneId);
  if (!scene) throw new RangeError('未知城市场景 '+sceneId);
  const family=sceneFamilies.find(item=>item.id===scene.family);
  const variant=sceneVariants[scene.variant-1];
  const rand=randomSource(scene.seed);
  const xs=[-50,-26,0,26,50].map(x=>x*variant.stretch[0]+(rand()-.5)*3.5);
  const zs=[-39,-13,13,39].map(z=>z*variant.stretch[1]+(rand()-.5)*3.5);
  const bounds=box(xs[0]-7,zs[0]-7,xs.at(-1)+7,zs.at(-1)+8);
  const roads=buildRoads(family,xs,zs,bounds,scene.variant-1);
  const graph=network(family,variant,xs,zs,roads,scene);
  const detail=scenery(family,scene,xs,zs,roads,bounds,graph,rand);
  const routes=makeRoutes(graph.nodes,graph.edges,scene.seed);
  const posts=graph.crossings.flatMap(c=>{
    return roads.find(r=>r.id===c.road).axis==='h'
      ? [{x:c.x1-.45,z:c.z1-.75,crossing:c.id},{x:c.x2+.45,z:c.z2+.75,crossing:c.id}]
      : [{x:c.x1-.75,z:c.z2+.45,crossing:c.id},{x:c.x2+.75,z:c.z1-.45,crossing:c.id}];
  });
  const lamps=graph.nodes.filter(node=>(node.index+scene.variant)%4!==0).map(node=>[node.x-2.54,node.z-2.48]);
  const {buildings,trees,props,water}=detail;
  const objects=[...buildings,...trees,...props,...water,...graph.barriers,
    ...posts.map(p=>({ ...rect(p.x,p.z,.19,.19),kind:'pole',height:2.7 })),
    ...lamps.map(([x,z])=>({ ...rect(x,z,.16,.16),kind:'pole',height:4.65 }))];
  const surfaceAt=(_x,_z)=>0;
  const result={ ...scene,family,variant,bounds,roads,cycleLanes:roads.flatMap(r=>r.cycle?[r.cycle]:[]),
    ...graph,...detail,posts,lamps,routes,facilityName:facilityNames[family.facility],surfaceAt,
    colliders:objects.map((item,i)=>({...item,id:'layout-'+i,y:0})),
  };
  cache.set(sceneId,result);
  if (cache.size>8) cache.delete(cache.keys().next().value);
  return result;
}
