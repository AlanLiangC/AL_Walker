import { Mesh } from './geometry.mjs';
import { material as m } from './materials.mjs';
import { randomSource } from './math.mjs';

const paint=(mesh,area,y,color,finish)=>mesh.flat(area.x1,area.z1,area.x2,area.z2,y,color,finish);

function street(mesh,road,roads) {
  paint(mesh,road,.002,'#515960',m.asphalt);
  if (road.cycle) paint(mesh,road.cycle,.013,'#4d8471',m.asphalt);
  const horizontal=road.axis==='h';
  const a=horizontal?road.x1:road.z1;
  const b=horizontal?road.x2:road.z2;
  const at=(x1,x2,z1,z2,y,tint)=>horizontal?mesh.flat(x1,z1,x2,z2,y,tint,m.roadPaint)
    :mesh.flat(z1,x1,z2,x2,y,tint,m.roadPaint);
  for (let p=a+1.3;p<b-2.6;p+=5.25) {
    if (roads.some(other=>other.axis!==road.axis&&Math.abs(other.center-p)<other.width*.5+3)) continue;
    at(p,p+2.6,road.center-.043,road.center+.043,.023,'#d7ae60');
    for (const side of [-1,1]) {
      const edge=road.center+side*(road.width/2-.18);
      at(p-.55,p+3.9,edge-.023,edge+.023,.024,'#d9d7be');
    }
  }
}

function facade(mesh,b,rng) {
  const {x1,x2,z1,z2,height}=b;
  const finish=height>13?m.concrete:m.brick;
  mesh.block(x1,0,z1,x2,height,z2,b.color,finish);
  mesh.block(x1-.085,height-.20,z1-.085,x2+.085,height+.15,z2+.085,'#a89b8c',m.concrete);
  if (b.storefront) mesh.block(x1+.4,2.5,z2-.10,x2-.4,2.77,z2+.45,'#5c6b6c',m.metal);
  const glass=['#526971','#58757b','#849394','#706f66'];
  for (const side of [-1,1]) {
    const x=side===1?x2:x1,z=side===1?z2:z1;
    for (let y=1.15;y<height-1.25;y+=2.6) {
      const lo=y-.06,hi=y+1.08;
      for (let p=x1+.7;p<x2-1.6;p+=2) {
        const tint=glass[Math.floor(rng()*glass.length)];
        mesh.block(p-.07,lo,Math.min(z,z+side*.06),p+1.23,hi+.07,Math.max(z,z+side*.06),'#8e8e81',m.metal);
        mesh.block(p,y,z+side*.08-.01,p+1.15,hi,z+side*.08+.01,tint,m.glass);
      }
      for (let p=z1+.7;p<z2-1.6;p+=2) {
        const tint=glass[Math.floor(rng()*glass.length)];
        mesh.block(x+side*.08-.01,y,p,x+side*.08+.01,hi,p+1.15,tint,m.glass);
      }
    }
  }
}

function tree(mesh,item,rand) {
  const {x,z,scale:s}=item;
  mesh.cylinder(x,z,0,3.8*s,.19*s,.09*s,'#796a54',9,m.bark);
  for (let i=0;i<10;i++) {
    const angle=i*2.4+rand()*.65;
    const ring=.6+rand()*.98;
    const tx=x+Math.cos(angle)*ring*s,tz=z+Math.sin(angle)*ring*s;
    mesh.tube([x,1.7*s,z],[tx,(2.65+i*.13)*s,tz],.061*s,.022*s,'#796a54',6,m.bark);
    for (let curl=0;curl<4;curl++) {
      const a=angle+curl*1.2;
      const dx=Math.cos(a)*(.7+rand()*.30)*s,dz=Math.sin(a)*(.64+rand()*.30)*s;
      const top=(3.65+i*.16+rand()*.54)*s;
      const shade=['#b4c4a7','#d0c990','#a5c99a','#d0d9aa'][curl];
      mesh.surface([tx-dx,top,tz-dz],[tx+dx,top,tz+dz],[tx+dx,top-s*.92,tz+dz],[tx-dx,top-s*.92,tz-dz],
        shade,m.leaves,[[.02,.015],[.405,.015],[.405,.91],[.02,.91]]);
    }
  }
}

function prop(mesh,item) {
  const {x1,x2,z1,z2,height,kind,color}=item;
  const x=(x1+x2)/2,z=(z1+z2)/2;
  if (kind==='shelter'||kind==='stall') {
    const tone=kind==='stall'?'#9e5744':'#46636c';
    for (const px of [x1+.1,x2-.1]) for (const pz of [z1+.1,z2-.1]) {
      mesh.cylinder(px,pz,0,height-.08,.057,.045,'#4b5658',8,m.metal);
    }
    mesh.block(x1-.12,height-.20,z1-.13,x2+.12,height,z2+.13,tone,m.enamel);
    mesh.block(x1,kind==='stall'?.72:.49,z2-.20,x2,kind==='stall'?.86:.56,z2,color,m.brick);
    if (kind==='shelter') mesh.block(x1,.73,z2-.11,x2,height-.18,z2-.05,'#6b7d7c',m.glass);
  } else if (kind==='bench') {
    mesh.block(x1,.32,z1,x2,.45,z2-.13,'#93795e',m.bark);
    mesh.block(x1,.44,z2-.17,x2,height,z2,'#a58564',m.bark);
    for (const dx of [-.51,.51]) mesh.block(x+dx-.045,0,z1+.07,x+dx+.045,.42,z2-.08,'#343f40',m.metal);
  } else if (kind==='planter') {
    mesh.block(x1,0,z1,x2,.37,z2,'#a79b86',m.concrete);
    for (const dx of [-.56,0,.56]) mesh.crown(x+dx,z,.36,.36,.55,'#587451');
  } else if (kind==='barrier') {
    mesh.block(x1,.26,z1,x2,height,z2,color,m.enamel);
    const alongX=x2-x1>z2-z1;
    const start=alongX?x1:z1,end=alongX?x2:z2;
    for (let p=start+.16;p<end-.23;p+=.49) {
      if (alongX) mesh.block(p,.71,z1-.012,p+.18,.92,z2+.012,'#e7c476',m.emitter);
      else mesh.block(x1-.012,.71,p,x2+.012,.92,p+.18,'#e7c476',m.emitter);
    }
  } else mesh.block(x1,0,z1,x2,height,z2,color,m.concrete);
}

function crossingPaint(mesh,c,road) {
  const horizontal=road.axis==='h';
  const tint=c.mode==='guard'?'#e3c35e':'#e4e3d1';
  if (horizontal) {
    for (let p=c.z1+.2;p<c.z2-.35;p+=.68) mesh.flat(c.x1+.12,p,c.x2-.12,p+.32,.029,tint,m.roadPaint);
    for (const z of [c.z1-.48,c.z2+.48]) mesh.flat(c.x1,z-.082,c.x2,z+.082,.026,'#e0b56d',m.roadPaint);
  } else {
    for (let p=c.x1+.2;p<c.x2-.35;p+=.68) mesh.flat(p,c.z1+.12,p+.32,c.z2-.12,.029,tint,m.roadPaint);
    for (const x of [c.x1-.48,c.x2+.48]) mesh.flat(x-.082,c.z1,x+.082,c.z2,.026,'#e0b56d',m.roadPaint);
  }
}

function signage(mesh,layout) {
  const posts=layout.posts;
  for (const post of posts) {
    const {x,z,crossing}=post;
    const type=layout.crossings.find(c=>c.id===crossing).mode;
    mesh.cylinder(x,z,0,2.65,.08,.065,'#5d6262',9,m.metal);
    const colors={signal:'#334740',guard:'#b09853',stop:'#b93f31',yield:'#e0bb74'};
    if (type==='stop') {
      mesh.tube([x,2.23,z-.045],[x,2.23,z+.045],.26,.26,colors[type],8,m.emitter);
      mesh.block(x-.12,2.205,z-.052,x+.12,2.254,z+.052,'#f4e9ce',m.emitter);
    } else mesh.block(x-.15,2.11,z-.15,x+.15,2.60,z+.15,colors[type],m.metal);
  }
}

export function urbanMesh(layout) {
  const mesh=new Mesh();
  const rng=randomSource(layout.seed^0x89ee3);
  const {bounds,nodes,edges,roads}=layout;
  mesh.flat(bounds.x1-115,bounds.z1-105,bounds.x2+115,bounds.z2+105,-.077,'#7e8865',m.grass);
  paint(mesh,bounds,-.045,layout.family.density>5?'#96998d':'#778d64',layout.family.density>5?m.concrete:m.grass);
  const pathColor=layout.family.surface==='brick'?'#c3a487':'#c7c4b0';
  for (const {x,z} of nodes) mesh.flat(x-2.5,z-2.5,x+2.5,z+2.5,-.005,pathColor,m[layout.family.surface]);
  for (const edge of edges) {
    const a=nodes[edge.from],b=nodes[edge.to];
    mesh.flat(a.x-1.85,a.z-1.85,b.x+1.85,b.z+1.85,-.008,pathColor,m[layout.family.surface]);
  }
  for (const zone of layout.zones) paint(mesh,zone,-.002,'#ab9980',m.paving);
  for (const road of roads) street(mesh,road,roads);
  for (const c of layout.crossings) crossingPaint(mesh,c,roads.find(r=>r.id===c.road));
  for (const water of layout.water) paint(mesh,water,-.013,'#4b7483',m.water);
  for (const area of layout.restricted) paint(mesh,area,-.004,'#b9856a',m.concrete);
  for (const item of layout.buildings) facade(mesh,item,rng);
  for (const item of layout.trees) tree(mesh,item,rng);
  for (const item of [...layout.props,...layout.barriers]) prop(mesh,item);
  signage(mesh,layout);
  for (const [x,z] of layout.lamps) {
    mesh.cylinder(x,z,0,4.55,.065,.045,'#536265',10,m.metal);
    mesh.block(x-.10,4.51,z-.64,x+.10,4.65,z+.12,'#bcb8a9',m.streetlamp);
  }
  return mesh;
}
