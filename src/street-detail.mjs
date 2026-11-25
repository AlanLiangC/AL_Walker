import { material, signTiles, tileUV } from './materials.mjs';
import { randomSource } from './math.mjs';

const m=material;

export function sign(mesh,left,right,low,high,z,label,direction=1) {
  const uv=tileUV(signTiles[label]);
  const [a,b]=direction===1 ? [left,right] : [right,left];
  mesh.surface([a,high,z],[b,high,z],[b,low,z],[a,low,z],'#ffffff',m.sign,uv);
}

function curbSquare(mesh,x,z,r,tint,y=.025) {
  mesh.flat(x-r,z-r,x+r,z+r,y,tint,m.metal);
}

function covers(mesh) {
  for (const [x,z] of [[-52,1.5],[-43,4.3],[-27,-2.3],[-8,2.4],[17,-2.7],[44,4.2],[3,21],[-2,-23],[41,-24]]) {
    mesh.cylinder(x,z,.006,.018,.395,.387,'#66696b',24,m.metal);
    mesh.cylinder(x,z,.024,.009,.345,.339,'#393d3f',24,m.metal);
    for (let i=-3;i<=3;i++) {
      const width=Math.sqrt(.329**2-(i*.075)**2);
      mesh.flat(x-width,z+i*.075-.012,x+width,z+i*.075+.012,.035,'#747875',m.metal);
    }
  }
  for (let x=-59;x<62;x+=7.1) {
    if (Math.abs(x)<9||Math.abs(Math.abs(x)-13)<2) continue;
    for (const z of [-5.73,7.02]) {
      mesh.flat(x-.24,z-.12,x+.24,z+.12,.029,'#454646',m.metal);
      for (let i=-3;i<=3;i++) mesh.flat(x+i*.06-.008,z-.103,x+i*.06+.008,z+.103,.030,'#171a1b');
    }
  }
}
function paintSegment(mesh,ax,az,bx,bz,y,width,tint) {
  const length=Math.hypot(bx-ax,bz-az);
  const dx=(bz-az)*width/(2*length),dz=(ax-bx)*width/(2*length);
  mesh.surface([ax+dx,y,az+dz],[bx+dx,y,bz+dz],[bx-dx,y,bz-dz],[ax-dx,y,az-dz],tint,m.roadPaint);
}
function bicycleMark(mesh,x,z) {
  const line=(ax,az,bx,bz) => paintSegment(mesh,x+ax,z+az,x+bx,z+bz,.028,.026,'#e2e1d0');
  for (const wheel of [-.39,.34]) for (let index=0;index<16;index++) {
    const a=index*Math.PI/8,b=(index+1)*Math.PI/8;
    line(wheel+.175*Math.cos(a),.17*Math.sin(a),wheel+.175*Math.cos(b),.17*Math.sin(b));
  }
  for (const [ax,az,bx,bz] of [[-.39,0,-.12,-.17],[-.12,-.17,.04,.08],[.04,.08,-.39,0],[-.12,-.17,.24,-.16],[.24,-.16,.04,.08],[.24,-.16,.34,0],[.20,-.23,.29,-.23],[-.20,-.19,-.07,-.19]]) {
    line(ax,az,bx,bz);
  }
}

export function streetDetails(mesh) {
  covers(mesh);
  for (const x of [-55,-36,-21,23,35,56]) bicycleMark(mesh,x,6.63);
  for (const [x,z] of [[-52,9.45],[-37,-8.75],[26,-8.69],[13.8,8.82],[51,8.83]]) {
    curbSquare(mesh,x,z,.12,'#8a8a7c',.156);
  }
  const parkX=-45.4, parkZ=11.7;
  for (const x of [parkX-.59,parkX+.59]) mesh.cylinder(x,parkZ,0,1.87,.039,.028,'#3f5049',12,m.metal);
  mesh.block(parkX-.71,.84,parkZ-.045,parkX+.71,1.62,parkZ+.04,'#263d34',m.enamel);
  sign(mesh,parkX-.67,parkX+.67,.87,1.59,parkZ-.047,'park',-1);
  // Low ground cover across the lawn reads from a camera at robot height.
  const random=randomSource(618);
  for (let i=0;i<4800;i++) {
    const x=-60+48*random(), z=11.3+36*random();
    const inPond=x>-51.7&&x<-34.3&&z>23.4&&z<37.7;
    const onPath=(z>15.75&&z<19.2)||(x>-32.3&&x<-27.7)||(z>38.8&&z<42.2);
    if (inPond||onPath) continue;
    const height=.032+random()*.095, width=.017+random()*.028;
    const hue=['#526438','#657046','#7c7852','#3b552d'][i%4];
    mesh.triangle([x-width,0,z],[x+width,0,z+.015],[x+width*.46,height,z-.02],hue,1);
    mesh.triangle([x,0,z-width],[x,0,z+width],[x-.022,height*.91,z+.01],hue,1);
  }
}
