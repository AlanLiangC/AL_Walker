import {
  Application, Asset, Color, Entity, Mesh, MeshInstance, PIXELFORMAT_RGBA8, PRIMITIVE_TRIANGLES,
  RESOLUTION_FIXED, RenderTarget, StandardMaterial, Texture,
} from 'playcanvas';
import { alleyWorld, scanOrigin } from './alley-world.mjs';
import { rigMotion } from './domain.mjs';
import { markers, robotMesh } from './geometry.mjs';
import { clamp, radians } from './math.mjs';
import { geometryRay, rayDirection, robots, sensorPose } from './sensors.mjs';
import { chaseOrbit, lookAround } from './view-controls.mjs';

const frameWidth=256,frameHeight=144;

function createMesh(device,geometry) {
  const mesh=new Mesh(device);
  const positions=[],normals=[],colors=[];
  for (let i=0;i<geometry.data.length;i+=12) {
    const [x,y,z,r,g,b,nx,ny,nz]=geometry.data.slice(i,i+9);
    positions.push(x,y,z);
    normals.push(nx,ny,nz);
    colors.push(Math.round(r*255),Math.round(g*255),Math.round(b*255),255);
  }
  mesh.setPositions(positions);
  mesh.setNormals(normals);
  mesh.setColors32(colors);
  mesh.update(PRIMITIVE_TRIANGLES);
  return mesh;
}

function addMesh(app,geometry,name,material) {
  const entity=new Entity(name);
  const mesh=createMesh(app.graphicsDevice,geometry);
  entity.addComponent('render',{ meshInstances:[new MeshInstance(mesh,material)] });
  app.root.addChild(entity);
  return entity;
}

function cameraFromPose(pose,fov,range) {
  const eye=[pose.x,pose.y,pose.z];
  const ray=rayDirection(pose.yaw,pose.pitch);
  return { eye,target:eye.map((v,i) => v+ray[i]),fov,range };
}

function cross([a,b,c],[x,y,z]) {
  return [b*z-c*y,c*x-a*z,a*y-b*x];
}
function unit(vector) {
  const magnitude=Math.hypot(...vector);
  return vector.map(value => value/magnitude);
}

function proxyDepth(sensor,pose) {
  const w=frameWidth,h=frameHeight;
  const look=rayDirection(pose.yaw,pose.pitch);
  const right=unit(cross(look,[0,1,0]));
  const up=cross(right,look);
  const origin=[pose.x,pose.y,pose.z];
  const horizontal=Math.tan(radians(sensor.fov)/2);
  const vertical=horizontal*h/w;
  const direction=new Float64Array(3);
  const data=new Float32Array(w*h);
  for (let y=0;y<h;y++) {
    const v=(1-2*(y+.5)/h)*vertical;
    for (let x=0;x<w;x++) {
      const u=(2*(x+.5)/w-1)*horizontal;
      for (let axis=0;axis<3;axis++) direction[axis]=look[axis]+right[axis]*u+up[axis]*v;
      const hit=geometryRay(origin,direction,sensor.range,alleyWorld.colliders,alleyWorld.groundRay);
      if (hit<sensor.range&&hit>.05) data[y*w+x]=hit;
    }
  }
  return { width:w,height:h,format:'depth-z-m',geometry:'collision-proxy',data };
}

async function loadScan(app,report) {
  const script=document.getElementById('scan-sogs');
  const inline=script ? JSON.parse(script.textContent) : null;
  const names=inline ? Object.keys(inline) : Array.from({ length:5 },(_,index) => 'artillery-'+index+'.sog');
  let ready=0;
  await Promise.all(names.map(async (name,index) => {
    const url=inline?.[name] ?? new URL('../assets/scan/'+name,import.meta.url).href;
    const response=await fetch(url);
    if (!response.ok) throw new Error('读取实景分块失败 '+response.status);
    const contents=await response.arrayBuffer();
    const asset=new Asset('Artillery Passage '+(index+1),'gsplat',{ url:name,filename:name,contents });
    app.assets.add(asset);
    await new Promise((resolve,reject) => {
      asset.ready(resolve);
      asset.once('error',message => reject(new Error(String(message))));
      app.assets.load(asset);
    });
    const tile=new Entity('街景分块 '+(index+1));
    tile.setPosition(scanOrigin.x,scanOrigin.y,scanOrigin.z);
    tile.setEulerAngles(0,0,180);
    tile.addComponent('gsplat',{ asset,unified:true });
    app.root.addChild(tile);
    report('正在加载伦敦实景 · '+(++ready)+' / '+names.length);
  }));
}

export class ScanRenderer {
  static async create(canvas,report) {
    const renderer=new ScanRenderer(canvas);
    try {
      await loadScan(renderer.app,report);
      renderer.app.start();
      return renderer;
    } catch (error) {
      renderer.app.destroy();
      throw error;
    }
  }

  constructor(canvas) {
    this.canvas=canvas;
    this.app=new Application(canvas,{
      graphicsDeviceOptions:{ antialias:false,powerPreference:'high-performance',alpha:false },
    });
    this.device=this.app.graphicsDevice;
    this.device.maxPixelRatio=1;
    this.app.scene.ambientLight=new Color(.53,.56,.60);
    const sun=new Entity('漫射日光');
    sun.addComponent('light',{ type:'directional',intensity:.8,color:new Color(1,.97,.91) });
    sun.setEulerAngles(51,26,13);
    this.app.root.addChild(sun);
    this.camera=new Entity('探测相机');
    this.camera.addComponent('camera',{
      clearColor:new Color(.66,.70,.74),nearClip:.065,farClip:130,horizontalFov:true,
    });
    this.app.root.addChild(this.camera);
    const painted=new StandardMaterial();
    painted.diffuseVertexColor=true;
    // The geometry has two-sided details such as sensor housings and thin rings.
    painted.cull=0;
    painted.update();
    this.robots=Object.fromEntries(Object.entries(robots).map(([id,spec]) =>
      [id,addMesh(this.app,robotMesh(spec,id==='g1'),id,painted)]));
    this.goal=addMesh(this.app,markers().goal,'终点',painted);
    const colorBuffer=new Texture(this.device,{ width:frameWidth,height:frameHeight,format:PIXELFORMAT_RGBA8,mipmaps:false });
    this.sensorTarget=new RenderTarget({ colorBuffer,depth:true });
  }

  setCamera({eye,target,fov,range}) {
    this.camera.setPosition(...eye);
    this.camera.lookAt(...target);
    this.camera.camera.fov=fov;
    this.camera.camera.farClip=range;
  }

  showRobot(id,player) {
    for (const [key,entity] of Object.entries(this.robots)) entity.enabled=key===id;
    if (!id) return;
    const entity=this.robots[id];
    entity.setPosition(player.x,player.y,player.z);
    entity.setEulerAngles(0,-player.yaw*180/Math.PI,0);
  }

  displayCamera(engine,_mode,selected,view) {
    const {player}=engine;
    const rig=rigMotion(player,engine.time,engine.domain,alleyWorld.surfaceAt,alleyWorld.bounds,0);
    const sensor=selected ?? engine.sensors.find(item => item.type==='rgb'||item.type==='depth');
    const original=sensor ? sensorPose(player,sensor,rig) : {
      x:player.x,y:player.y+engine.robot.height,z:player.z,yaw:player.yaw,pitch:rig.pitch,
    };
    const {pose,fov}=lookAround(original,sensor?.fov??86,view);
    return cameraFromPose(pose,fov,130);
  }

  render(engine,mode,selected,view) {
    if (this.capturing) return;
    const { clientWidth,clientHeight }=this.canvas;
    if (!clientWidth||!clientHeight) return;
    const factor=clamp(devicePixelRatio||1,1,1.22);
    const width=Math.round(clientWidth*factor),height=Math.round(clientHeight*factor);
    if (width!==this.width||height!==this.height) {
      this.app.setCanvasResolution(RESOLUTION_FIXED,width,height);
      this.width=width;
      this.height=height;
    }
    const player=engine.player;
    const [gx,gz]=engine.task.points.at(-1);
    this.goal.setPosition(gx,alleyWorld.surfaceAt(gx,gz),gz);
    this.goal.setLocalScale(.56,.56,.56);
    this.goal.enabled=true;
    const pivotHeight=.67+Math.max(0,engine.robot.height-.6)*.29;
    const {eye,target}=chaseOrbit(player,view,{ distance:2.58,elevation:.23,height:pivotHeight });
    const pivot=[player.x,player.y+pivotHeight,player.z];
    const offset=eye.map((value,i)=>value-pivot[i]);
    const distance=Math.hypot(...offset);
    const direction=offset.map(value=>value/distance);
    const clearance=geometryRay(pivot,direction,distance,alleyWorld.colliders,alleyWorld.groundRay)-.12;
    if (mode==='robot'||clearance<.78) {
      this.setCamera(this.displayCamera(engine,mode,selected,view));
      this.showRobot(null);
    } else {
      this.setCamera({ eye:pivot.map((value,i)=>value+direction[i]*clearance),target,fov:78,range:130 });
      this.showRobot(engine.robotId,player);
    }
    this.app.renderNextFrame=true;
  }

  useTarget(target,view) {
    const camera=this.camera;
    const saved={ position:camera.getPosition().clone(), rotation:camera.getRotation().clone(),
      fov:camera.camera.fov, range:camera.camera.farClip, goal:this.goal.enabled,target:camera.camera.renderTarget,
      robot:Object.keys(this.robots).find(id => this.robots[id].enabled) };
    this.goal.enabled=false;
    this.showRobot(null);
    this.setCamera(view);
    camera.camera.renderTarget=target;
    return ()=>{
      camera.camera.renderTarget=saved.target;
      camera.setPosition(saved.position);
      camera.setRotation(saved.rotation);
      camera.camera.fov=saved.fov;
      camera.camera.farClip=saved.range;
      this.goal.enabled=saved.goal;
      if (saved.robot) this.robots[saved.robot].enabled=true;
      this.app.renderNextFrame=true;
    };
  }

  readTarget(target) {
    const {width,height}=target;
    const pixels=new Uint8Array(width*height*4);
    this.device.setRenderTarget(target);
    this.device.updateBegin();
    try {
      this.device.readPixels(0,0,width,height,pixels);
    } finally {
      this.device.updateEnd();
      this.device.setRenderTarget(null);
    }
    const data=new Uint8Array(pixels.length),stride=width*4;
    for (let y=0;y<height;y++) {
      const from=(height-1-y)*stride;
      data.set(pixels.subarray(from,from+stride),y*stride);
    }
    return data;
  }

  async capturePhoto(tick,view) {
    if (this.capturing) throw new Error('已经在等待一帧实景图像');
    const start=performance.now(),width=1280,height=704;
    if (!this.photoTarget) {
      const colorBuffer=new Texture(this.device,{width,height,format:PIXELFORMAT_RGBA8,mipmaps:false});
      this.photoTarget=new RenderTarget({colorBuffer,depth:true});
    }
    const target=this.photoTarget,restore=this.useTarget(target,view);
    const timeout=AbortSignal.timeout(15_000);
    this.capturing=true;
    let sorted,rendered,expire,pixels;
    try {
      pixels=await new Promise((resolve,reject)=>{
        let ready=false;
        sorted=this.app.systems.gsplat.on('frame:ready',(camera,_layer,isReady,loading)=>{
          if (camera===this.camera.camera&&camera.renderTarget===target) ready=isReady&&!loading;
        });
        expire=()=>reject(new Error('实景渲染超时'));
        timeout.addEventListener('abort',expire);
        rendered=this.app.on('frameend',()=>{
          if (!ready) return;
          try { resolve(this.readTarget(target)); }
          catch (error) { reject(error); }
        });
        this.app.renderNextFrame=true;
      });
    } finally {
      sorted?.off();
      rendered?.off();
      timeout.removeEventListener('abort',expire);
      restore();
      this.capturing=false;
    }
    const canvas=new OffscreenCanvas(width,height);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer),width,height),0,0);
    const image=await canvas.convertToBlob({type:'image/png'});
    return { key:crypto.randomUUID(),tick,image,renderMs:performance.now()-start };
  }

  grabFrame(_state,sensor,pose) {
    if (sensor.type==='depth') return proxyDepth(sensor,pose);
    const restore=this.useTarget(this.sensorTarget,cameraFromPose(pose,sensor.fov,sensor.range));
    let data;
    try {
      this.app.render();
      data=this.readTarget(this.sensorTarget);
    } finally {
      restore();
    }
    return { width:frameWidth,height:frameHeight,format:'rgba8',data };
  }
}
