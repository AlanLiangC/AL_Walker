import { randomSource } from './math.mjs';
import { material } from './materials.mjs';
import { sign, streetDetails } from './street-detail.mjs';
import {
  bounds, buildings, construction, crossings, cycleLane, furniture, GOAL_RADIUS, lightPoles, localWalk,
  park, parkPaths, plazas, pond, ramp, roads, sidewalks, streetLamps, surfaceAt, terrace, trees,
} from './city.mjs';

const colors = new Map();
function rgb(hex) {
  if (!colors.has(hex)) colors.set(hex,[1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255));
  return colors.get(hex);
}

export class Mesh {
  data = [];

  triangle(a,b,c,tint,shade=1,finish=material.plain,uv=[[0,0],[0,0],[0,0]]) {
    const color=rgb(tint).map(channel => channel*shade);
    const [x,y,z]=b.map((value,i) => value-a[i]);
    const [u,v,w]=c.map((value,i) => value-a[i]);
    const normal=[z*v-y*w,x*w-z*u,y*u-x*v];
    const length=Math.hypot(...normal);
    if (length<1e-9) return;
    const n=normal.map(value => value/length);
    for (const [i,point] of [a,b,c].entries()) this.data.push(...point,...color,...n,finish,...uv[i]);
  }

  quad(a,b,c,d,tint,shade=1,finish=material.plain) {
    this.triangle(a,b,c,tint,shade,finish);
    this.triangle(a,c,d,tint,shade,finish);
  }

  surface(a,b,c,d,tint,finish,uv=[[0,0],[1,0],[1,1],[0,1]]) {
    this.triangle(a,b,c,tint,1,finish,[uv[0],uv[1],uv[2]]);
    this.triangle(a,c,d,tint,1,finish,[uv[0],uv[2],uv[3]]);
  }

  flat(x1,z1,x2,z2,y,color,finish) {
    this.quad([x1,y,z1],[x2,y,z1],[x2,y,z2],[x1,y,z2],color,1,finish);
  }

  block(x1,y1,z1,x2,y2,z2,color,finish) {
    const a=[x1,y1,z1], b=[x2,y1,z1], c=[x2,y1,z2], d=[x1,y1,z2];
    const e=[x1,y2,z1], f=[x2,y2,z1], g=[x2,y2,z2], h=[x1,y2,z2];
    this.quad(e,f,g,h,color,1,finish);
    this.quad(a,b,f,e,color,.95,finish);
    this.quad(b,c,g,f,color,.94,finish);
    this.quad(c,d,h,g,color,1,finish);
    this.quad(d,a,e,h,color,.96,finish);
  }

  cylinder(x,z,y,height,r1,r2,color,sides=10,finish) {
    this.tube([x,y,z],[x,y+height,z],r1,r2,color,sides,finish);
  }

  tube(from,to,r1,r2,color,sides=10,finish=material.plain) {
    const [x,y,z]=to.map((value,i) => value-from[i]);
    const length=Math.hypot(x,y,z);
    const direction=[x/length,y/length,z/length];
    const lateral=Math.abs(direction[1])>.95 ? [1,0,0] : [-z/Math.hypot(x,z),0,x/Math.hypot(x,z)];
    // Choose an orthogonal basis even for branches leaning a few degrees from vertical.
    const ortho=direction.map((value,i) => lateral[i]-value*direction.reduce((sum,d,j) => sum+d*lateral[j],0));
    const radius=Math.hypot(...ortho);
    const tangent=ortho.map(value => value/radius);
    const binormal=[
      tangent[1]*direction[2]-tangent[2]*direction[1],
      tangent[2]*direction[0]-tangent[0]*direction[2],
      tangent[0]*direction[1]-tangent[1]*direction[0],
    ];
    const ring=(angle,r,point) => point.map((value,i) =>
      value+r*(tangent[i]*Math.cos(angle)+binormal[i]*Math.sin(angle)));
    for (let i=0; i<sides; i++) {
      const a=i*Math.PI*2/sides, b=(i+1)*Math.PI*2/sides;
      const p=ring(a,r1,from), q=ring(b,r1,from), r=ring(b,r2,to), s=ring(a,r2,to);
      this.quad(p,q,r,s,color,1,finish);
      this.triangle(to,s,r,color,1,finish);
      this.triangle(from,q,p,color,1,finish);
    }
  }

  bevel(x1,y1,z1,x2,y2,z2,edge,color,finish) {
    const ring=(y,inset) => {
      const l=x1+inset,r=x2-inset,f=z1+inset,b=z2-inset,cut=edge*.75;
      return [[l+cut,y,f],[r-cut,y,f],[r,y,f+cut],[r,y,b-cut],
        [r-cut,y,b],[l+cut,y,b],[l,y,b-cut],[l,y,f+cut]];
    };
    const rings=[ring(y1,edge*.55),ring(y1+edge,0),ring(y2-edge,0),ring(y2,edge*.55)];
    for (let layer=1;layer<rings.length;layer++) for (let i=0;i<8;i++) {
      const next=(i+1)%8,lower=rings[layer-1],upper=rings[layer];
      this.quad(lower[i],lower[next],upper[next],upper[i],color,1,finish);
    }
    const top=rings.at(-1);
    for (let i=1;i<7;i++) this.triangle(top[0],top[i],top[i+1],color,1,finish);
  }

  ellipsoid(x,y,z,rx,ry,rz,color,finish=material.plain,sides=12) {
    const point=(latitude,longitude) => [
      x+Math.cos(latitude)*Math.cos(longitude)*rx,
      y+Math.sin(latitude)*ry,
      z+Math.cos(latitude)*Math.sin(longitude)*rz,
    ];
    for (let ring=0;ring<6;ring++) {
      const low=(ring/6-.5)*Math.PI, high=((ring+1)/6-.5)*Math.PI;
      for (let i=0;i<sides;i++) {
        const a=i/sides*2*Math.PI,b=(i+1)/sides*2*Math.PI;
        this.quad(point(low,a),point(low,b),point(high,b),point(high,a),color,1,finish);
      }
    }
  }

  place(mesh,x,y,z,yaw) {
    const sine=Math.sin(yaw),cosine=Math.cos(yaw);
    for (let i=0;i<mesh.data.length;i+=12) {
      const [px,py,pz,r,g,b,nx,ny,nz,finish,u,v]=mesh.data.slice(i,i+12);
      this.data.push(x+cosine*px-sine*pz,y+py,z+sine*px+cosine*pz,r,g,b,
        cosine*nx-sine*nz,ny,sine*nx+cosine*nz,finish,u,v);
    }
  }

  crown(x,z,y,r,h,color) {
    this.cylinder(x,z,y,h*.27,r*.57,r,color,9);
    this.cylinder(x,z,y+h*.27,h*.40,r,r*.82,color,9);
    this.cylinder(x,z,y+h*.67,h*.33,r*.82,.06,color,9);
  }
}

function paintArea(mesh,area,y,color,finish) {
  mesh.flat(area.x1,area.z1,area.x2,area.z2,y,color,finish);
}

function sidewalk(mesh,area) {
  const split = (lower,upper,values) => [...new Set([lower,...values.filter(v => v>lower&&v<upper),upper])].sort((a,b) => a-b);
  const xs=split(area.x1,area.x2,crossings.flatMap(c => [c.x1-.85,c.x1,c.x2,c.x2+.85]));
  const zs=split(area.z1,area.z2,crossings.flatMap(c => [c.z1-.85,c.z1,c.z2,c.z2+.85]));
  for (let i=1; i<xs.length; i++) {
    for (let j=1; j<zs.length; j++) {
      const x1=xs[i-1],x2=xs[i],z1=zs[j-1],z2=zs[j];
      const a=[x1,surfaceAt(x1+.0001,z1+.0001)+.005,z1];
      const b=[x2,surfaceAt(x2-.0001,z1+.0001)+.005,z1];
      const c=[x2,surfaceAt(x2-.0001,z2-.0001)+.005,z2];
      const d=[x1,surfaceAt(x1+.0001,z2-.0001)+.005,z2];
      mesh.quad(a,b,c,d,'#c3c2b8',1,material.paving);
      for (const [u,v] of [[a,b],[b,c],[c,d],[d,a]]) {
        mesh.quad(u,v,[v[0],0,v[2]],[u[0],0,u[2]],'#94938a',1,material.concrete);
      }
    }
  }
  const alongX = area.x2-area.x1 > area.z2-area.z1;
  const start = alongX ? area.x1 : area.z1;
  const end = alongX ? area.x2 : area.z2;
  for (let s=Math.ceil(start/2.4)*2.4; s<end; s+=2.4) {
    const [x,z] = alongX ? [s,(area.z1+area.z2)/2] : [(area.x1+area.x2)/2,s];
    const y=surfaceAt(x,z);
    if (y < .139) continue;
    if (alongX) mesh.flat(s-.014,area.z1+.05,s+.014,area.z2-.05,y+.008,'#abb1a5');
    else mesh.flat(area.x1+.05,s-.014,area.x2-.05,s+.014,y+.008,'#abb1a5');
  }
}

function architecture(mesh,b,rnd) {
  const {x1,z1,x2,z2,height,color}=b;
  const tall=height>16;
  const isLibrary=b.sign==='CITY LIBRARY';
  const wall=tall ? material.concrete : material.brick;
  mesh.flat(x1-.67,z1-.65,x2+.72,z2+.85,.021,'#a09b90',material.paving);
  mesh.block(x1,0,z1,x2,height,z2,color,wall);
  mesh.block(x1-.19,height-.12,z1-.19,x2+.19,height+.23,z2+.19,'#aeb1a9',material.concrete);
  mesh.block(x1+1,height,z1+1,x1+3.5,height+.92,z1+3.4,'#8f9188',material.concrete);
  mesh.block(x1+.75,height+.92,z1+.78,x1+3.76,height+1.13,z1+3.66,'#9da099',material.metal);
  const frames=tall ? '#526063' : '#464642';
  const glass=['#536b70','#566873','#76858a','#506464','#637879'];
  const floors=(start,end,window,horizontal) => {
    const n=Math.floor((end-start)/2.25);
    const interval=(end-start)/n;
    const story=tall ? 2.96 : 2.61;
    for (let y=2.15;y<height-1.3;y+=story) {
      for (let i=0;i<n;i++) {
        const middle=start+(i+.5)*interval;
        const span=interval*(tall?.39:.31);
        const [l,r]=[middle-span,middle+span];
        const high=y+(tall ? 1.91 : 1.42);
        const tint=glass[Math.floor(rnd()*glass.length)];
        window(l-.085,r+.085,y-.085,high+.095,frames,material.metal,.028);
        window(l,r,y,high,tint,material.glass,.052);
        window(middle-.024,middle+.024,y,high,frames,material.metal,.071);
        window(l,r,y+.43,y+.46,'#a3aaa4',material.metal,.071);
        if (!tall) window(l-.11,r+.11,y-.10,y-.045,'#b8b3a7',material.brick,.14);
      }
      if (tall) horizontal(y-.24,y-.14);
    }
  };
  for (const side of [-1,1]) {
    const z=side<0 ? z1 : z2;
    const plate=(l,r,lo,hi,tint,finish,depth) => 
      mesh.block(l,lo,Math.min(z,z+side*depth),r,hi,Math.max(z,z+side*depth),tint,finish);
    floors(x1,x2,plate,(lo,hi) => plate(x1,x2,lo,hi,'#b4baac',material.concrete,.13));
    if (side===1 && (b.sign||height<11)) {
      const bays=Math.floor((x2-x1)/2.15);
      for (let i=0;i<bays;i++) {
        const l=x1+.31+i*(x2-x1-.5)/bays,r=l+(x2-x1-.5)/bays-.21;
        plate(l,r,.14,2.79,'#464e4c',material.metal,.055);
        plate(l+.071,r-.071,.39,2.68,i===0 ? '#737e75' : '#3d4a48',material.glass,.082);
        plate(l+.071,r-.071,1.18,1.21,'#78817b',material.metal,.104);
        plate(r-.16,r-.137,1.02,1.31,'#c2c7bc',material.metal,.13);
      }
      const label=b.sign ?? 'coffee';
      const mid=(x1+x2)/2, signWidth=isLibrary ? 3.9 : 3.6;
      mesh.block(mid-signWidth/2-.1,2.94,z-.02,mid+signWidth/2+.1,3.90,z+.19,'#5d594b',material.metal);
      sign(mesh,mid-signWidth/2,mid+signWidth/2,3,3.84,z+.195,label);
      mesh.bevel(x1+.26,2.83,z2+.02,x2-.24,2.99,z2+.69,.035,'#6d6456',material.metal);
    }
  }
  for (const side of [-1,1]) {
    const x=side<0 ? x1 : x2;
    const plate=(l,r,lo,hi,tint,finish,depth) =>
      mesh.block(Math.min(x,x+side*depth),lo,l,Math.max(x,x+side*depth),hi,r,tint,finish);
    floors(z1,z2,plate,(lo,hi) => plate(z1,z2,lo,hi,'#b4baac',material.concrete,.13));
  }
}

function urbanTree(mesh,x,z,index,rng) {
  const scale=.81+rng()*.28;
  const shift=(rng()-.5)*.38;
  const mid=[x+shift*.38,1.54*scale,z+.04];
  const crown=[x+shift,3.17*scale,z+.1];
  mesh.tube([x,0,z],mid,.243*scale,.137*scale,'#75665c',16,material.bark);
  mesh.tube(mid,crown,.138*scale,.071*scale,'#75665c',13,material.bark);
  for (let i=0;i<5;i++) {
    const a=i*Math.PI*.4+index;
    mesh.tube([x+Math.cos(a)*.31,.017,z+Math.sin(a)*.31],
      [x,.27,z],.037,.101,'#75665c',6,material.bark);
  }
  for (let branch=0;branch<12;branch++) {
    const a=branch*2.399963+index*.59;
    const ring=1.44+(.23-rng()*.40);
    const outer=branch<8 ? ring : ring*.58;
    const start=[x+shift*.4,(1.75+branch*.12)*scale,z+.05];
    const end=[x+Math.cos(a)*outer*scale,(3.15+branch*.205+rng()*.22)*scale,z+Math.sin(a)*outer*scale];
    const elbow=start.map((value,i) => value+(end[i]-value)*.62);
    mesh.tube(start,elbow,.087*scale,.041*scale,'#746a5b',8,material.bark);
    mesh.tube(elbow,end,.043*scale,.012*scale,'#75685a',7,material.bark);
    for (let twig=0;twig<14;twig++) {
      const angle=rng()*Math.PI*2;
      const spread=.45+rng()*.59;
      const px=end[0]+Math.cos(angle)*spread*scale*(.7+rng()*.23);
      const pz=end[2]+Math.sin(angle)*spread*scale*(.7+rng()*.23);
      const py=end[1]+(-.38+rng()*.86)*scale;
      const width=(.35+.29*rng())*scale, height=(.46+.36*rng())*scale;
      const tilt=(rng()-.5)*1.29,spanX=Math.cos(angle)*width,spanZ=Math.sin(angle)*width;
      const topX=Math.cos(angle+1.57)*tilt*height,topZ=Math.sin(angle+1.57)*tilt*height;
      const color=['#f4eed1','#bccbb5','#e2db9a','#c6cfb0'][(twig+index)%4];
      const uv=twig%2 ?
        [[.018,.014],[.402,.014],[.402,.918],[.018,.918]] :
        [[.439,.03],[.825,.03],[.825,.596],[.439,.596]];
      mesh.surface([px-spanX+topX,py+height,pz-spanZ+topZ],[px+spanX+topX,py+height,pz+spanZ+topZ],
        [px+spanX-topX,py-height,pz+spanZ-topZ],[px-spanX-topX,py-height,pz-spanZ-topZ],color,material.leaves,uv);
    }
  }
}

export function cityMesh() {
  const m = new Mesh();
  const rng=randomSource(66);
  m.flat(-205,-180,205,180,-.083,'#8c9369',material.grass);
  paintArea(m,bounds,-.041,'#8f9676',material.grass);
  paintArea(m,park,-.028,'#729155',material.grass);
  paintArea(m,pond,-.027,'#457582',material.water);
  for (const p of [...parkPaths,...plazas,localWalk]) paintArea(m,p,-.012,'#c3c5b3',material.paving);
  paintArea(m,construction,-.003,'#ad946d',material.concrete);
  for (const road of roads) paintArea(m,road,0,'#41464a',material.asphalt);
  for (const area of sidewalks) sidewalk(m,area);
  const {x1,z1,x2,z2}=ramp;
  m.quad([x1,.006,z1],[x2,.006,z1],[x2,.704,z2],[x1,.704,z2],'#c6c9b9',1,material.paving);
  for (const x of [x1,x2]) m.triangle([x,0,z1],[x,.7,z2],[x,0,z2],'#a7b09e');
  m.block(terrace.x1,0,terrace.z1,terrace.x2,.7,terrace.z2,'#c6c9b9',material.paving);
  for (let z=40; z<50; z++) m.flat(47.2,z,59.8,z+.021,.706,'#afb5a8');
  for (const x of [48.15,55.85]) {
    for (const z of [34.2,36.5,38.85]) {
      const y=surfaceAt(x,z);
      m.cylinder(x,z,y,.58,.035,.035,'#6b8183',6);
    }
    m.quad([x-.035,.6,34],[x+.035,.6,34],[x+.035,1.3,39],[x-.035,1.3,39],'#677a7c');
  }
  paintArea(m,cycleLane,.018,'#447266',material.asphalt);
  m.flat(-65,7.17,65,7.22,.019,'#dbe9d6',material.roadPaint);
  m.flat(-65,6.02,65,6.065,.019,'#edf1dd',material.roadPaint);
  for (let x=-63; x<64; x+=6) {
    if (Math.abs(x)<8) continue;
    m.flat(x,-.055,x+2.8,.055,.012,'#d6c48f',material.roadPaint);
    m.flat(x,6.61,x+1.1,6.68,.020,'#acc6b6');
  }
  for (let z=-54; z<55; z+=6) {
    if (Math.abs(z)<7) continue;
    m.flat(-.055,z,.055,z+2.8,.013,'#d6c48f',material.roadPaint);
  }
  for (let z=-54; z<-17; z+=5) m.flat(40.96,z,41.04,z+2,.018,'#b8b99c',material.roadPaint);
  for (const crossing of crossings) {
    const {x1,x2,z1,z2,road}=crossing;
    if (road === 'eastWest') {
      for (let z=z1+.18; z<z2-.38; z+=.77) m.flat(x1+.16,z,x2-.16,z+.36,.026,'#e8e6d6',material.roadPaint);
      for (const z of [-6.41,7.86]) {
        const y=surfaceAt((x1+x2)/2,z)+.008;
        m.flat(x1+.20,z,x2-.20,z+.13,y,'#cbb078',material.roadPaint);
      }
    } else {
      for (let x=x1+.18; x<x2-.40; x+=.72) m.flat(x,z1+.15,x+.35,z2-.15,.023,'#e8e6d6',material.roadPaint);
    }
  }
  for (const x of [-18.2,18.2]) m.flat(x-.10,x<0 ? -5.72 : .34,x+.10,x<0 ? -.34 : 5.72,.023,'#e3dfc5',material.roadPaint);
  for (const z of [-18.2,18.2]) m.flat(z<0 ? -5.72 : .34,z-.1,z<0 ? -.34 : 5.72,z+.1,.023,'#e3dfc5',material.roadPaint);

  for (const building of buildings) architecture(m,building,rng);
  for (const [index,[x,z]] of trees.entries()) urbanTree(m,x,z,index,rng);
  streetDetails(m);
  for (const [x,z,w,h] of [[82,-13,12,32],[97,-25,18,24],[105,-49,15,44],[110,5,18,36],
      [128,-33,13,51],[132,15,22,27],[151,5,24,52],[119,31,12,34],[94,30,14,23],[-76,-36,12,27]]) {
    const building={ x1:x,z1:z,x2:x+w,z2:z+10,height:h,color:'#909a9c' };
    architecture(m,building,rng);
  }
  for (const [x,z] of streetLamps) {
    const y=surfaceAt(x,z);
    const side=z>0 ? -1 : 1;
    m.cylinder(x,z,y,4.8,.074,.052,'#424e51',12,material.metal);
    m.block(x-.038,y+4.68,Math.min(z,z+side*.88),x+.038,y+4.78,Math.max(z,z+side*.88),'#536766');
    m.block(x-.14,y+4.59,z+side*.88-.19,x+.14,y+4.73,z+side*.88+.19,'#a9aea0',material.metal);
    m.block(x-.115,y+4.578,z+side*.88-.15,x+.115,y+4.59,z+side*.88+.15,'#d6c3a7',material.streetlamp);
  }
  for (const {x,z} of lightPoles) {
    const y=surfaceAt(x,z);
    m.cylinder(x,z,y,3.45,.093,.074,'#495e60',12,material.metal);
    m.block(x-.21,y+2.37,z-.21,x+.21,y+3.14,z+.21,'#263f42');
    m.block(x-.15,y+2.30,z-.15,x+.15,y+2.39,z+.15,'#849593');
  }
  for (const item of furniture) furnish(m,item);
  return m;
}

function furnish(m,item) {
  const {x1,z1,x2,z2,height,kind}=item;
  const x=(x1+x2)/2, z=(z1+z2)/2, y=surfaceAt(x,z);
  const block=(lo,hi,color) => m.block(x1,y+lo,z1,x2,y+hi,z2,color);
  if (kind==='bench') {
    block(.33,.43,'#a38c68');
    m.block(x1,y+.38,z2-.11,x2,y+.76,z2,'#8c785c');
    for (const lx of [x1+.12,x2-.17]) m.block(lx,y,z1+.1,lx+.06,y+.38,z2-.1,'#536363');
  } else if (kind==='shelter') {
    m.bevel(x1-.20,y+2.49,z1-.20,x2+.20,y+height,z2+.20,.08,'#52636a',material.metal);
    for (const sx of [x1+.12,x2-.19]) {
      for (const sz of [z1+.09,z2-.15]) m.block(sx,y,sz,sx+.075,y+2.55,sz+.075,'#526a68');
    }
    m.block(x1+.12,y+.72,z2-.17,x2-.12,y+2.49,z2-.11,'#435359',material.glass);
    m.block(x1+.68,y+.4,z2-.57,x2-.62,y+.49,z2-.17,'#b9a583');
    sign(m,x1+.49,x2-.49,y+2.47,y+2.77,z1-.204,'stop',-1);
    m.block(x2-.76,y+.92,z1+.05,x2-.18,y+2.18,z1+.11,'#314347',material.enamel);
    sign(m,x2-.73,x2-.21,y+1.02,y+2.07,z1+.046,'stop',-1);
  } else if (kind==='parked-car') {
    m.place(actorMesh({kind:'car',color:item.color}),x,y,z,Math.PI/2);
  } else if (kind==='barrier') {
    block(.32,height,'#b89560');
    const across=x2-x1>z2-z1;
    const length=across ? x2-x1 : z2-z1;
    for (let offset=.08; offset<length-.19; offset+=.85) {
      if (across) m.block(x1+offset,y+.53,z1-.013,x1+offset+.29,y+.79,z2+.013,'#eee1ae');
      else m.block(x1-.013,y+.53,z1+offset,x2+.013,y+.79,z1+offset+.29,'#eee1ae');
    }
  } else if (kind==='cone') {
    m.block(x-.26,y,z-.26,x+.26,y+.07,z+.26,'#5b6664');
    m.cylinder(x,z,y+.07,.22,.23,.15,'#ca793e',9);
    m.cylinder(x,z,y+.29,.105,.15,.113,'#f5dfaa',9);
    m.cylinder(x,z,y+.395,.24,.113,.025,'#ca793e',9);
  } else if (kind==='container') {
    block(0,height,'#89714f');
    for (let x=x1+.2; x<x2; x+=.44) m.block(x,y+.1,z2,x+.06,y+height-.1,z2+.035,'#aa865c');
  } else if (kind==='planter') {
    block(0,height*.57,'#8d8f79');
    m.crown(x,z,y+height*.54,Math.min(x2-x1,z2-z1)*.43,height*.76,'#69875f');
  } else {
    m.cylinder(x,z,y,height,(x2-x1)*.48,(x2-x1)*.43,'#607e70');
  }
}

const finish=material;

export function robotMesh(robot,human,phase=0) {
  const m=new Mesh();
  const w=robot.width/2,l=robot.length/2,h=robot.height;
  if (human) {
    for (const side of [-1,1]) {
      const x=side*.114;
      const swing=side*phase;
      const hips=[x,.573,.014],knee=[x,.301,-swing*.079],ankle=[x,.082,swing*.12];
      m.tube(hips,knee,.066,.048,'#a1aaae',12,finish.enamel);
      m.tube(knee,ankle,.048,.036,'#77818a',12,finish.metal);
      m.ellipsoid(...knee,.059,.061,.061,'#3c474c',finish.metal);
      m.bevel(x-.053,.014,ankle[2]-.120,x+.053,.087,ankle[2]+.075,.022,'#2e353a');
      m.ellipsoid(side*.194,.957,.007,.048,.064,.061,'#c0c6c7',finish.enamel);
      m.tube([side*.2,.928,0],[side*.232,.735,swing*.104],.038,.034,'#69737a',12,finish.metal);
      m.tube([side*.232,.735,swing*.104],[side*.218,.574,swing*.122],.034,.027,'#9aa6ab',10,finish.enamel);
    }
    m.bevel(-w*.69,.56,-.132,w*.69,.991,.12,.046,robot.color,finish.enamel);
    m.bevel(-.10,.76,.11,.10,.936,.145,.013,'#555e63',finish.metal);
    m.tube([0,.95,0],[0,1.075,0],.053,.054,'#444d51',13,finish.metal);
    m.ellipsoid(0,1.16,0,.099,.151,.104,'#b2bec5',finish.enamel);
    m.bevel(-.077,1.12,-.111,.077,1.224,-.073,.016,'#253743',finish.glass);
    m.block(-.044,1.175,-.116,.044,1.19,-.111,'#8cdeda',finish.emitter);
  } else {
    m.bevel(-w*.84,h*.49,-l*.87,w*.84,h*.87,l*.87,.037,'#3a4247',finish.metal);
    m.bevel(-w*.86,h*.705,-l*.81,w*.86,h*.959,l*.84,.032,robot.color,finish.enamel);
    m.bevel(-w*.75,h*.53,-l*.968,w*.75,h*.79,-l*.76,.024,'#323a40',finish.metal);
    m.bevel(-w*.60,h*.764,-l*.997,w*.60,h*.914,-l*.77,.012,'#203039',finish.glass);
    m.cylinder(0,-l*.35,h*.925,.041,.068,.062,'#272d2f',12,finish.metal);
    m.cylinder(0,-l*.35,h*.954,.026,.061,.060,'#586a73',12,finish.glass);
    m.bevel(-w*.69,h*.515,l*.80,w*.69,h*.79,l*.968,.018,'#2c3437',finish.metal);
    m.bevel(-w*.44,h*.68,l*.955,w*.44,h*.795,l*.983,.008,'#39464c',finish.glass);
    for (const side of [-1,1]) {
      const x=side*w*.80;
      m.block(side*w*.83-.019,h*.711,l*.968,side*w*.83+.018,h*.745,l*.986,'#e77843',finish.emitter);
      for (const [index,z] of [-l*.69,l*.68].entries()) {
        const swing=side*(index===0?phase:-phase);
        const knee=[x,h*.286,z-.056+swing*.07];
        const foot=[x,.07+.052*Math.max(0,swing),z+swing*.086];
        m.tube([x,h*.66,z],knee,.038,.031,'#424b50',12,finish.metal);
        m.tube(knee,foot,.026,.020,'#818d94',10,finish.metal);
        for (const [cy,cz,r] of [[h*.655,z,.066],[knee[1],knee[2],.040]]) {
          m.tube([x-side*.014,cy,cz],[x+side*.05,cy,cz],r,r*.91,'#303a40',16,finish.metal);
          m.tube([x+side*.049,cy,cz],[x+side*.057,cy,cz],r*.57,r*.57,'#919da3',12,finish.metal);
        }
        m.bevel(x-.045,foot[1]-.044,foot[2]-.048,x+.045,foot[1]+.011,foot[2]+.064,.014,'#2b3438');
      }
    }
  }
  return m;
}

function vehicle(m,actor,detail) {
  const van=actor.kind==='van';
  const l=van ? 2.33 : 2.01,w=van ? 1.02 : .92;
  const roof=van ? 2.16 : 1.48,ledge=van ? 1.01 : .85;
  const hood=van ? -l+.65 : -l+.98, cabFront=hood+.47;
  const cabBack=van ? l-.24 : l-.91, cargo=van ? l-.16 : l-.47;
  const half=w*(van?.85:.83),top=half*.86;
  const color=actor.color;
  const axles=[-l+.57,l-.61];
  if (detail) {
    m.bevel(-w,.66,-l,w,ledge,l,.055,color,finish.enamel);
    m.bevel(-w*.80,.28,-l+.055,w*.80,.70,l-.055,.045,'#343a3b');
    const arch=.357;
    const sections=[-l,...axles.flatMap(center=>Array.from({length:11},(_,i)=>center+arch*(i/5-1))),l];
    const lower=z=>.325+Math.sqrt(Math.max(0,...axles.map(center=>arch**2-(z-center)**2)));
    for (const side of [-1,1]) {
      const x=side*w*.985;
      for (let n=1;n<sections.length;n++) {
        const a=sections[n-1],b=sections[n];
        m.quad([x,lower(a),a],[x,lower(b),b],[x,.72,b],[x,.72,a],color,1,finish.enamel);
      }
    }
  } else {
    m.bevel(-w,.24,-l,w,ledge,l,.092,color,finish.enamel);
  }
  m.bevel(-w*.91,.20,-l-.018,w*.91,.34,-l+.10,.04,'#272e32',finish.metal);
  m.bevel(-w*.91,.20,l-.10,w*.91,.36,l+.018,.04,'#323838',finish.metal);
  m.surface([-half,ledge,hood],[half,ledge,hood],[top,roof-.08,cabFront],[-top,roof-.08,cabFront],'#35444e',finish.glass);
  m.surface([-top,roof-.08,cabBack],[top,roof-.08,cabBack],[half,ledge,cargo],[-half,ledge,cargo],'#3a4952',finish.glass);
  m.bevel(-top,roof-.105,cabFront-.027,top,roof,cabBack+.039,.031,color,finish.enamel);
  for (const side of [-1,1]) {
    const x=side*half, inner=side*top;
    m.surface([x,ledge,hood],[x,ledge,cargo],[inner,roof-.07,cabBack],[inner,roof-.07,cabFront],'#40525b',finish.glass);
    const middle=(cabFront+cabBack)*.52;
    m.tube([x,ledge,middle],[inner,roof-.063,middle],.024,.025,'#30383c',8,finish.metal);
    m.tube([x,ledge,hood],[x,ledge,cargo],.019,.019,'#a3abae',8,finish.metal);
    m.bevel(x-.065,ledge-.07,cabFront-.15,x+.065,ledge+.015,cabFront+.05,.025,color,finish.enamel);
    const innerRoll=side*w*.74, outerRoll=side*w*.985;
    for (const z of axles) {
      m.tube([innerRoll,.325,z],[outerRoll,.325,z],.307,.307,'#25292a',24);
      m.tube([outerRoll,.325,z],[outerRoll+side*.006,.325,z],.205,.202,'#999e9e',20,finish.metal);
      m.tube([outerRoll+side*.008,.325,z],[outerRoll+side*.015,.325,z],.079,.074,'#434b4e',12,finish.metal);
      if (detail) {
        const face=outerRoll+side*.017;
        for (let hole=0;hole<8;hole++) {
          const angle=hole*Math.PI/4;
          const y=.325+Math.cos(angle)*.148, q=z+Math.sin(angle)*.148;
          m.tube([face,y,q],[face+side*.004,y,q],.029,.025,'#30353a',9,finish.metal);
        }
      }
    }
    if (detail) {
      const bodySide=side*w, join=side*.029;
      m.tube([x,ledge,hood],[inner,roof-.07,cabFront],.018,.022,'#44484a',8,finish.metal);
      m.tube([x,ledge,cargo],[inner,roof-.07,cabBack],.018,.022,'#44484a',8,finish.metal);
      if (van) {
        const end=cabFront+(cabBack-cabFront)*.29;
        const bottom=hood+(cargo-hood)*.37;
        m.surface([x+join,ledge,bottom],[x+join,ledge,cargo],[inner+join,roof-.075,cabBack],
          [inner+join,roof-.075,end],color,finish.enamel);
      }
      for (const z of van?[hood+.14,.88]:[hood+.17,.57]) {
        m.tube([bodySide,ledge-.05,z],[bodySide,.65,z],.0045,.0045,'#343b3e',5,finish.metal);
        m.bevel(bodySide-.010,ledge-.105,z+.13,bodySide+.010,ledge-.079,z+.25,.005,'#77817f',finish.metal);
      }
    }
    const lx=side*w*.70;
    m.bevel(lx-.162,ledge-.21,-l-.024,lx+.162,ledge-.065,-l+.018,.012,'#e8e5d3',finish.emitter);
    m.bevel(lx-.170,ledge-.20,l-.017,lx+.170,ledge-.06,l+.023,.012,'#9a3b2d',finish.emitter);
  }
  m.block(-w*.39,.42,-l-.022,w*.39,.563,-l+.003,'#252c31',finish.metal);
  for (let i=0;i<4;i++) m.block(-w*.38,.438+i*.027,-l-.026,w*.38,.449+i*.027,-l-.022,'#545d62',finish.metal);
  m.block(-.17,.40,l+.018,.17,.51,l+.03,'#dad4bd');
}

export function actorMesh(actor,{ detail=false }={}) {
  const m=new Mesh();
  if (actor.kind==='pedestrian') {
    m.ellipsoid(0,1.119,.018,.182,.32,.122,actor.color);
    m.tube([0,1.37,0],[0,1.53,0],.055,.046,'#ba947b',12);
    m.ellipsoid(0,1.584,-.023,.111,.150,.108,'#c29a82');
    m.ellipsoid(0,1.654,.012,.112,.094,.103,'#393732');
    m.ellipsoid(0,1.581,-.126,.021,.026,.025,'#c49a81');
    for (const side of [-1,1]) {
      m.ellipsoid(side*.153,1.311,.016,.074,.102,.079,actor.color);
      m.tube([side*.174,1.310,.01],[side*.222,1.072,-.010],.060,.042,actor.color,10);
      m.tube([side*.222,1.072,-.01],[side*.207,.887,-.070],.040,.027,'#b38d77',10);
      m.ellipsoid(side*.204,.877,-.071,.035,.055,.031,'#b38d77');
    }
  } else if (actor.kind==='bike') {
    for (const z of [-.60,.60]) {
      m.tube([-.032,.285,z],[.032,.285,z],.275,.275,'#303333',24);
      m.tube([-.041,.285,z],[.041,.285,z],.213,.213,'#777e7c',24,finish.metal);
      m.tube([-.046,.285,z],[.046,.285,z],.182,.182,'#333837',24);
    }
    for (const pair of [[[-.02,.29,-.60],[0,.73,-.31]],[[0,.29,.59],[0,.69,.24]],
      [[0,.69,.24],[0,.73,-.31]],[[0,.29,.15],[0,.69,.24]],[[0,.29,.15],[0,.73,-.31]]]) {
      m.tube(...pair,.021,.021,'#535c52',9,finish.metal);
    }
    m.tube([-.29,.82,-.49],[.29,.82,-.49],.020,.020,'#494d4b',8,finish.metal);
    m.ellipsoid(0,1.05,-.067,.171,.285,.149,actor.color);
    m.ellipsoid(0,1.402,-.205,.107,.145,.109,'#bd9278');
    m.ellipsoid(0,1.477,-.182,.131,.084,.125,'#c8c7b4',finish.enamel);
    for (const side of [-1,1]) {
      m.tube([side*.139,1.195,-.13],[side*.205,.836,-.474],.047,.030,actor.color,9);
      m.tube([side*.065,.865,.057],[side*.153,.574,-.12],.078,.058,'#4f5456',9);
      m.tube([side*.153,.574,-.12],[side*.132,.395,.149],.056,.045,'#4f5456',9);
    }
  } else vehicle(m,actor,detail);
  return m;
}

export function pedestrianLeg(swing) {
  const m=new Mesh();
  const end=swing*.16;
  m.quad([-.071,.82,.073],[.071,.82,.073],[.061,.13,end+.060],[-.061,.13,end+.060],'#516467');
  m.quad([-.071,.82,-.073],[.071,.82,-.073],[.061,.13,end-.060],[-.061,.13,end-.060],'#607174');
  m.quad([-.071,.82,-.073],[-.071,.82,.073],[-.061,.13,end+.060],[-.061,.13,end-.060],'#48595d');
  m.quad([.071,.82,-.073],[.071,.82,.073],[.061,.13,end+.060],[.061,.13,end-.060],'#48595d');
  m.block(-.067,.046,end-.119,.067,.145,end+.069,'#344749');
  return m;
}

export function markers() {
  const goal=new Mesh();
  const light=new Mesh();
  for (let i=0; i<40; i++) {
    const a=i*Math.PI*2/40, b=(i+1)*Math.PI*2/40;
    const p=(r,t) => [Math.cos(t)*r,.032,Math.sin(t)*r];
    goal.quad(p(GOAL_RADIUS-.11,a),p(GOAL_RADIUS-.11,b),p(GOAL_RADIUS,b),p(GOAL_RADIUS,a),'#51c49b');
  }
  goal.cylinder(0,0,.03,.75,.047,.047,'#539e85',8);
  goal.cylinder(0,0,.74,.24,.13,.28,'#354f52',12);
  goal.cylinder(0,0,.98,.27,.28,0,'#78d8ad',12);
  light.cylinder(0,0,0,.21,.127,.127,'#ffffff',14,material.emitter);
  return {goal,light};
}
