import { buildings, construction, crossings, crossingSignal, cycleLane, landmarks, park, plazas, pond, roads, sidewalks } from './city.mjs';
import { alleyObstacles, alleyProfile } from './alley-world.mjs';

export function drawMap(canvas,scaleLabel,engine,mode) {
  const ratio=Math.min(devicePixelRatio||1,2);
  const w=canvas.clientWidth, h=canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width!==Math.round(w*ratio) || canvas.height!==Math.round(h*ratio)) {
    canvas.width=Math.round(w*ratio);
    canvas.height=Math.round(h*ratio);
  }
  const ctx=canvas.getContext('2d');
  ctx.setTransform(ratio,0,0,ratio,0,0);
  ctx.fillStyle='#263a32';
  ctx.fillRect(0,0,w,h);
  const p=engine.player;
  const scan=engine.world.id==='scan';
  const layout=engine.world.layout;
  const limits=engine.world.bounds;
  const s=scan
    ? (mode==='overview' ? Math.min(w/18,h/43) : Math.min(w,h)/17)
    : (mode==='overview' ? Math.min(w/(limits.x2-limits.x1+7),h/(limits.z2-limits.z1+7)) : Math.min(w,h)/56);
  const cx=mode==='overview' ? (limits.x1+limits.x2)/2 : p.x;
  const cz=mode==='overview' ? (scan?16.5:(limits.z1+limits.z2)/2) : p.z;
  const toX=x => (x-cx)*s+w/2;
  const toY=z => (z-cz)*s+h/2;
  const area=(rect,fill) => {
    ctx.fillStyle=fill;
    ctx.fillRect(toX(rect.x1),toY(rect.z1),(rect.x2-rect.x1)*s,(rect.z2-rect.z1)*s);
  };
  const grid=scan ? 2 : 10;
  ctx.strokeStyle='#31473b';
  ctx.lineWidth=1;
  ctx.beginPath();
  for (let x=-100;x<=100;x+=grid) { ctx.moveTo(toX(x),0); ctx.lineTo(toX(x),h); }
  for (let z=-100;z<=100;z+=grid) { ctx.moveTo(0,toY(z)); ctx.lineTo(w,toY(z)); }
  ctx.stroke();
  if (layout) {
    for (const item of layout.zones) area(item,'#6c6351');
    for (const item of layout.water) area(item,'#3f7278');
    for (const edge of layout.edges) {
      const a=layout.nodes[edge.from],b=layout.nodes[edge.to];
      area({x1:a.x-1.7,z1:a.z-1.7,x2:b.x+1.7,z2:b.z+1.7},'#64766c');
    }
    for (const road of layout.roads) area(road,'#43504c');
    for (const lane of layout.cycleLanes) area(lane,'#487765');
    for (const crossing of layout.crossings) {
      const signal=engine.world.crossingSignal(engine.time,crossing).state;
      area(crossing,({walk:'#9cc8ae',stop:'#c38372',yield:'#cab388','full-stop':'#dc925c'})[signal]);
    }
    for (const item of layout.buildings) area(item,'#76857a');
    for (const item of layout.barriers) area(item,'#d79368');
  } else if (scan) {
    ctx.beginPath();
    const profile=alleyProfile.filter(item => item.z<=38);
    for (const [i,row] of profile.entries()) ctx[i?'lineTo':'moveTo'](toX(row.left),toY(row.z));
    for (const row of [...profile].reverse()) ctx.lineTo(toX(row.right),toY(row.z));
    ctx.closePath();
    ctx.fillStyle='#617268';
    ctx.fill();
    for (const obstacle of alleyObstacles) area(obstacle,'#e0b57b');
    ctx.font='11px system-ui, sans-serif';
    ctx.fillStyle='#acc1b4';
    ctx.fillText('北口',toX(3),toY(.6));
    ctx.fillText('街巷墙面',toX(3),toY(13));
    ctx.fillText('南段店铺',toX(3),toY(33.1));
  } else {
    area(park,'#335343');
    area(pond,'#355f60');
    for (const tile of plazas) area(tile,'#40554b');
    for (const tile of sidewalks) area(tile,'#516158');
    for (const street of roads) area(street,'#56645e');
    area(cycleLane,'#638374');
    for (const b of buildings) area(b,'#3e5048');
    area(construction,'#705d45');
    ctx.save();
    ctx.beginPath();
    ctx.rect(toX(construction.x1),toY(construction.z1),(construction.x2-construction.x1)*s,(construction.z2-construction.z1)*s);
    ctx.clip();
    ctx.strokeStyle='#9c7955';
    for (let x=construction.x1-20;x<construction.x2;x+=3) {
      ctx.beginPath();
      ctx.moveTo(toX(x),toY(construction.z2));
      ctx.lineTo(toX(x+18),toY(construction.z1));
      ctx.stroke();
    }
    ctx.restore();
    for (const crossing of crossings) {
      const signal=crossingSignal(engine.time,crossing).state;
      area(crossing,({ walk:'#a0c6ab',stop:'#bd9284',yield:'#c3b184' })[signal]);
    }
    ctx.font='10px system-ui, sans-serif';
    ctx.textAlign='center';
    ctx.fillStyle='#c2d2c7';
    for (const {x,z,name} of landmarks) ctx.fillText(name,toX(x),toY(z));
    ctx.fillStyle='#d5dbce';
    ctx.fillText('滨河大道',toX(-39),toY(1.5));
    ctx.fillText('中轴路',toX(6),toY(-45));
  }
  const points=engine.task.points;
  ctx.beginPath();
  points.forEach(([x,z],i) => ctx[i?'lineTo':'moveTo'](toX(x),toY(z)));
  ctx.strokeStyle='#244e41';
  ctx.lineWidth=6;
  ctx.lineJoin='round';
  ctx.lineCap='round';
  ctx.stroke();
  ctx.strokeStyle='#91e6b5';
  ctx.lineWidth=3;
  ctx.stroke();
  const dot=(point,r,fill,outline) => {
    ctx.beginPath();
    ctx.arc(toX(point[0]),toY(point[1]),r,0,Math.PI*2);
    ctx.fillStyle=fill;
    ctx.fill();
    ctx.strokeStyle=outline;
    ctx.lineWidth=1.5;
    ctx.stroke();
  };
  dot(points[0],4,'#d2e8d9','#345047');
  dot(points.at(-1),5,'#91e6b5','#18352d');
  for (const actor of engine.actors) {
    const color=actor.kind==='pedestrian' ? '#c0baa1' : '#e1b980';
    dot([actor.x,actor.z],actor.kind==='car'||actor.kind==='van' ? 2.5 : 1.7,color,'#4f5141');
  }
  ctx.save();
  ctx.translate(toX(p.x),toY(p.z));
  ctx.rotate(p.yaw);
  ctx.beginPath();
  ctx.moveTo(0,-8); ctx.lineTo(5.1,5.4); ctx.lineTo(0,3.2); ctx.lineTo(-5.1,5.4); ctx.closePath();
  ctx.fillStyle='#f3fcf5';
  ctx.strokeStyle='#207756';
  ctx.lineWidth=2;
  ctx.stroke();
  ctx.fill();
  ctx.restore();
  const meters=scan ? (mode==='overview'?5:2) : (mode==='overview'?20:10);
  scaleLabel.textContent=meters+' m';
  scaleLabel.style.setProperty('--scale',meters*s+'px');
}
