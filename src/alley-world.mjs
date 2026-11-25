import { clamp, lerp } from './math.mjs';

export const scanOrigin={ x:2.5,y:-.78,z:30 };
export const laneSpeed=1.55;
const normal=(x,z) => [scanOrigin.x-x,scanOrigin.z+z];

// Surveyed in the capture coordinates. Retain each bend in ground and facade.
const streetProfile=[
  [-34,.84,-2.0,7.0],[-29,.77,.0,6.0],[-27,.71,1.55,4.60],
  [-25,.73,1.44,4.39],[-22,.77,1.43,4.25],[-19,.84,1.38,4.14],
  [-16,.88,1.25,4.05],[-14,.92,.95,4.01],[-13,.94,1.15,3.98],
  [-12,.97,1.15,3.95],[-10,.99,1.06,3.92],[-7,1.06,1.05,3.9],
  [-4,1.11,.97,3.88],[0,1.11,.90,3.85],[4,1.09,.84,3.85],
  [8,1.09,.77,3.85],[12,1.07,.60,3.85],[16,1.09,.49,3.70],[20,1.09,.46,3.62],
];
export const alleyProfile=streetProfile.map(([z,y,west,east]) => ({
  z:z+scanOrigin.z,y:y+scanOrigin.y,left:scanOrigin.x-east,right:scanOrigin.x-west,
}));

function gradeAt(z) {
  const rows=alleyProfile;
  const index=rows.findIndex(item => item.z>z);
  if (index<=0) return index===0 ? rows[0] : rows.at(-1);
  const a=rows[index-1],b=rows[index],part=(z-a.z)/(b.z-a.z);
  return { y:lerp(a.y,b.y,part),left:lerp(a.left,b.left,part),right:lerp(a.right,b.right,part) };
}

function boxFromRaw(name,xlo,zlo,xhi,zhi,height) {
  const [x1,z1]=normal(xhi,zlo),[x2,z2]=normal(xlo,zhi);
  return { id:name,kind:name,x1,z1,x2,z2,y:gradeAt((z1+z2)/2).y,height };
}

export const alleyObstacles=[
  boxFromRaw('alley-bollard',2.81,-24.55,3.04,-24.29,1.04),
  boxFromRaw('alley-bin',3.25,-19.79,4.13,-18.97,1.37),
  boxFromRaw('alley-lamp',2.64,-13.96,2.92,-13.65,4.15),
  boxFromRaw('alley-box',3.43,-10.02,3.96,-9.22,1.14),
  boxFromRaw('alley-bin',.90,.32,1.68,1.85,1.28),
  boxFromRaw('alley-bike',1.90,8.60,2.74,9.65,1.25),
].map((item,index) => ({...item,id:item.id+'-'+index}));

const wallHeight=12;
const wallColliders=[];
for (let start=-3.8;start<37;start+=.55) {
  const end=start+.55,a=gradeAt(start),b=gradeAt(end);
  wallColliders.push({
    id:'alley-west-wall',kind:'alley-wall',x1:Math.max(a.right,b.right),x2:9,
    z1:start,z2:end,y:Math.min(a.y,b.y)-.10,height:wallHeight,
  },{
    id:'alley-east-wall',kind:'alley-wall',x1:-9,x2:Math.min(a.left,b.left),
    z1:start,z2:end,y:Math.min(a.y,b.y)-.10,height:wallHeight,
  });
}

const alleyTask={
  id:'artillery',name:'伦敦实景穿巷',from:'Artillery Passage 北口',to:'南段店铺前',
  description:'沿真实扫描街巷通过石柱、垃圾桶和路灯，抵达南段标记。注意狭窄路段的机身余量。',
  conditions:'实拍街景 · 狭窄通道 · 固定障碍',limit:90,seed:77,
  points:[[2.75,-30.2],[2.55,-27.8],[2.18,-25.9],[2.13,-25.1],[2.13,-23.6],[2.25,-22.4],[2.28,-18.6],[1.98,-15.3],
    [1.98,-13.3],[2.30,-10.5],[2.48,-7],[2.55,-1],[2.47,4.35]].map(([x,z])=>normal(x,z)),
};

function groundRay(origin,direction,limit) {
  const [,y,z]=origin,[,dy,dz]=direction;
  let closest=limit;
  for (let i=1;i<alleyProfile.length;i++) {
    const a=alleyProfile[i-1],b=alleyProfile[i];
    const slope=(b.y-a.y)/(b.z-a.z);
    const delta=dy-slope*dz;
    if (Math.abs(delta)<1e-9) continue;
    const hit=(a.y+slope*(z-a.z)-y)/delta;
    if (hit<=0||hit>=closest) continue;
    const position=z+dz*hit;
    if (position>=a.z&&position<=b.z) closest=hit;
  }
  return closest;
}

function checkAlleyRules(engine,player,_actors,dt) {
  const over=Math.abs(player.speed)>laneSpeed+.10;
  const prior=engine.ruleExposure.speeding ?? 0;
  const next=over ? prior+dt : 0;
  engine.ruleExposure.speeding=next;
  if (next>=.8&&prior<.8) engine.penalize('speeding',null,player);
  return { speedLimit:laneSpeed, yieldTarget:false, crossing:null };
}

export const alleyWorld={
  id:'scan',tasks:[alleyTask],speedLimit:laneSpeed,bounds:{ x1:-8,z1:-3.6,x2:8,z2:37 },
  surfaceAt:(_x,z) => gradeAt(clamp(z,-4,50)).y,
  colliders:[...wallColliders,...alleyObstacles],
  groundRay,checkRules:checkAlleyRules,createTraffic:()=>[],advanceTraffic:()=>[],
  crossings:[],goalRadius:.82,profiles:['ideal','outdoor'],paved:()=>true,
};
