import { crossings, crossingSignal, lightPoles, streetLamps, surfaceAt, tasks } from './city.mjs';
import { rigMotion } from './domain.mjs';
import { Mesh, actorMesh, cityMesh, markers, pedestrianLeg, robotMesh } from './geometry.mjs';
import { forward, radians } from './math.mjs';
import { geometryFragment, geometryVertex, rainFragment, skyFragment, skyVertex, sun } from './lighting.mjs';
import { material, uploadTexture } from './materials.mjs';
import { actorClass, layoutClass } from './render-layout.mjs';
import { rayDirection, robots, sensorPose } from './sensors.mjs';
import { urbanMesh } from './urban-geometry.mjs';
import { chaseOrbit, lookAround, overheadOrbit } from './view-controls.mjs';

function programFor(gl,vertex,fragment) {
  function shader(type,source) {
    const id=gl.createShader(type);
    gl.shaderSource(id,source);
    gl.compileShader(id);
    if (!gl.getShaderParameter(id,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(id));
    return id;
  }
  const program=gl.createProgram();
  gl.attachShader(program,shader(gl.VERTEX_SHADER,vertex));
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  return program;
}

const unit = vector => {
  const length=Math.hypot(...vector);
  return vector.map(component => component/length);
};
const cross = ([a,b,c],[x,y,z]) => [b*z-c*y,c*x-a*z,a*y-b*x];
const dot = ([a,b,c],[x,y,z]) => a*x+b*y+c*z;

function basisAt(eye,target) {
  const back=unit(eye.map((value,index) => value-target[index]));
  const right=unit(cross(Math.abs(back[1])>.999 ? [0,0,-1] : [0,1,0],back));
  return { back,right,up:cross(back,right) };
}

function viewAt(eye,target) {
  const {back,right,up}=basisAt(eye,target);
  return new Float32Array([
    right[0],up[0],back[0],0, right[1],up[1],back[1],0, right[2],up[2],back[2],0,
    -dot(right,eye),-dot(up,eye),-dot(back,eye),1,
  ]);
}

function ortho(radius,near,far) {
  return new Float32Array([
    1/radius,0,0,0, 0,1/radius,0,0,
    0,0,-2/(far-near),0, 0,0,-(far+near)/(far-near),1,
  ]);
}

function multiply(a,b) {
  const matrix=new Float32Array(16);
  for (let column=0;column<4;column++) for (let row=0;row<4;row++) {
    for (let k=0;k<4;k++) matrix[column*4+row]+=a[k*4+row]*b[column*4+k];
  }
  return matrix;
}

function uniforms(gl,program,names) {
  return Object.fromEntries(names.split(' ').map(name => [name,gl.getUniformLocation(program,'u'+name)]));
}

function perspective(fov,aspect,far) {
  const near=.055;
  const h=1/Math.tan(radians(fov)/2);
  return new Float32Array([
    h,0,0,0, 0,h*aspect,0,0, 0,0,(far+near)/(near-far),-1, 0,0,2*far*near/(near-far),0,
  ]);
}

function cameraView(pose,fov,far) {
  const eye=[pose.x,pose.y,pose.z];
  const direction=rayDirection(pose.yaw,pose.pitch);
  return { eye,target:eye.map((value,index) => value+direction[index]),fov,far };
}

function* crossingLamps(engine,world) {
  for (const {x,z,crossing:id} of (world?.layout?.posts??lightPoles)) {
    const crossing=(world?.crossings??crossings).find(item=>item.id===id);
    if (!crossing||crossing.mode==='stop'||crossing.mode==='yield') continue;
    const walk=(world?.crossingSignal??crossingSignal)(engine.time,crossing).state==='walk';
    const y=(world?.surfaceAt??surfaceAt)(x,z);
    yield {x,z,walk,high:y+(world?.layout?2.40:2.83),low:y+(world?.layout?2.12:2.44)};
  }
}

function routeMesh(task,ground=surfaceAt) {
  const mesh=new Mesh();
  for (let index=1; index<task.points.length; index++) {
    const from=task.points[index-1];
    const to=task.points[index];
    const length=Math.hypot(to[0]-from[0],to[1]-from[1]);
    const [x,z]=from;
    const dx=(to[0]-x)/length, dz=(to[1]-z)/length;
    for (let t=.8; t<length-.2; t+=2.1) {
      const cx=x+dx*t, cz=z+dz*t;
      const y=ground(cx,cz)+.065;
      mesh.quad([cx-dx*.34-dz*.1,y,cz-dz*.34+dx*.1],[cx+dx*.24-dz*.1,y,cz+dz*.24+dx*.1],
        [cx+dx*.24+dz*.1,y,cz+dz*.24-dx*.1],[cx-dx*.34+dz*.1,y,cz-dz*.34-dx*.1],'#68ba9d',1,material.emitter);
    }
  }
  return mesh;
}

export class CityRenderer {
  constructor(canvas,images) {
    this.canvas=canvas;
    this.gl=canvas.getContext('webgl',{ alpha:true, antialias:true });
    if (!this.gl) throw new Error('当前浏览器未启用 WebGL');
    const gl=this.gl;
    const hasGradient=!!(gl.getExtension('OES_standard_derivatives')&&gl.getExtension('EXT_shader_texture_lod'));
    this.photoSupported=gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS)>=9;
    this.program=programFor(gl,geometryVertex,geometryFragment(hasGradient,this.photoSupported));
    this.locations=uniforms(gl,this.program,
      'Projection View Position Scale Yaw Tint Pass Semantic Sun Haze Eye Weather Overcast Snow Night Time SunVP ShadowTexel Albedo Relief Leaves Sky Sign Shadow Reflect Reflection ReflectionVP Headlamp Ahead Lanterns[0] Photo PhotoColor PhotoDepth PhotoVP');
    this.attributes=Object.fromEntries(['Point','Color','Normal','Material','UV']
      .map(name => [name,gl.getAttribLocation(this.program,'a'+name)]));
    this.skyProgram=programFor(gl,skyVertex,skyFragment);
    this.skyLocations=uniforms(gl,this.skyProgram,'CameraX CameraY CameraZ Sky Sun Haze Overcast Night Photo PhotoColor PhotoDepth PhotoVP');
    this.skyPoint=gl.getAttribLocation(this.skyProgram,'aPoint');
    this.skyBuffer=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,this.skyBuffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    this.rainProgram=programFor(gl,skyVertex,rainFragment);
    this.rainPoint=gl.getAttribLocation(this.rainProgram,'aPoint');
    this.rainLocations=uniforms(gl,this.rainProgram,'Time Aspect Intensity Snow');
    this.lanterns=new Float32Array(streetLamps.flatMap(([x,z]) =>
      [x,surfaceAt(x,z)+4.57,z+(z>0 ? -.88 : .88)]));
    this.materialTextures=images.map((image,index) => uploadTexture(gl,image,{ repeatX:index===3,mipmaps:index>1||hasGradient }));
    this.city=this.upload(cityMesh());
    this.robotMeshes=Object.fromEntries(Object.entries(robots).map(([key,robot]) =>
      [key,Array.from({length:9},(_,index) => this.upload(robotMesh(robot,key==='g1',(index-4)/4)))]));
    this.actorMeshes=new Map();
    this.detailedActors=new Map();
    this.legs=[-1,-.5,0,.5,1].map(swing => this.upload(pedestrianLeg(swing)));
    this.markers=Object.fromEntries(Object.entries(markers()).map(([key,mesh]) => [key,this.upload(mesh)]));
    this.routes=Object.fromEntries(tasks.map(task => [task.id,this.upload(routeMesh(task))]));
    this.target=this.createTarget(256,144);
    const shadowSize=Math.min(2048,gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.shadow=this.createTarget(shadowSize,shadowSize);
    this.reflection=this.createTarget(512,288);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.DITHER);
    gl.depthFunc(gl.LEQUAL);
  }

  createTarget(width,height) {
    const gl=this.gl;
    const texture=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,texture);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    const depth=gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER,depth);
    gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,width,height);
    const frame=gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE) throw Error('传感器帧缓冲区不可用');
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return { frame,width,height,texture,depth };
  }

  selectWorld(world) {
    const layout=world?.layout;
    if (layout===this.layout) return;
    if (this.urbanCity) this.gl.deleteBuffer(this.urbanCity.buffer);
    this.layout=layout;
    this.urbanCity=layout ? this.upload(urbanMesh(layout,{semantic:true})) : null;
    this.urbanLanterns=layout ? new Float32Array(Array.from({length:streetLamps.length},(_,i)=>
      layout.lamps[i] ? [layout.lamps[i][0],4.51,layout.lamps[i][1]-.25] : [0,-1000,0]).flat()) : null;
  }

  pathBuffer(task,world) {
    if (!world.layout) return this.routes[task.id];
    if (this.urbanTask!==task) {
      if (this.urbanRoute) this.gl.deleteBuffer(this.urbanRoute.buffer);
      this.urbanRoute=this.upload(routeMesh(task,world.surfaceAt));
      this.urbanTask=task;
    }
    return this.urbanRoute;
  }

  upload(mesh) {
    const gl=this.gl;
    const buffer=gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,mesh.data instanceof Float32Array?mesh.data:new Float32Array(mesh.data),gl.STATIC_DRAW);
    return { buffer,count:mesh.data.length/12 };
  }

  async loadDetailedActors(endpoint) {
    if (!globalThis.DecompressionStream) return;
    const sources=[['car','vehicles/car.f32.gz',1],['van','vehicles/van.f32.gz',1],
      ['pedestrian','casual-walker.f32.gz',9]];
    return this.actorLoad??=Promise.all(sources.map(async ([kind,asset,poses])=>{
      const path=new URL('/assets/visual/'+asset,new URL(endpoint,location.href));
      try {
        const response=await fetch(path,{signal:AbortSignal.timeout(3000)});
        if (!response.ok||!response.body) return;
        const data=await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
        if (data.byteLength===0||data.byteLength%(144*poses)!==0) return;
        const bytes=data.byteLength/poses;
        this.detailedActors.set(kind,Array.from({length:poses},(_,index)=>
          this.upload({data:new Float32Array(data,index*bytes,bytes/4)})));
      } catch {
        // The built-in meshes are available without the optional assets.
      }
    }));
  }

  draw(mesh,x=0,y=0,z=0,yaw=0,tint=[1,1,1],scale=[1,1,1]) {
    const gl=this.gl;
    const u=this.locations;
    gl.bindBuffer(gl.ARRAY_BUFFER,mesh.buffer);
    const a=this.attributes;
    gl.vertexAttribPointer(a.Point,3,gl.FLOAT,false,48,0);
    gl.vertexAttribPointer(a.Color,3,gl.FLOAT,false,48,12);
    gl.vertexAttribPointer(a.Normal,3,gl.FLOAT,false,48,24);
    gl.vertexAttribPointer(a.Material,1,gl.FLOAT,false,48,36);
    gl.vertexAttribPointer(a.UV,2,gl.FLOAT,false,48,40);
    gl.uniform3f(u.Position,x,y,z);
    gl.uniform3fv(u.Scale,scale);
    gl.uniform1f(u.Yaw,yaw);
    gl.uniform3fv(u.Tint,tint);
    gl.drawArrays(gl.TRIANGLES,0,mesh.count);
  }

  bindMaterials(shadowTexture,reflectionTexture=this.materialTextures[0]) {
    const gl=this.gl,u=this.locations;
    const names=['Albedo','Relief','Leaves','Sky','Sign','Shadow','Reflection'];
    for (const [index,texture] of [...this.materialTextures,shadowTexture,reflectionTexture].entries()) {
      gl.activeTexture(gl.TEXTURE0+index);
      gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.uniform1i(u[names[index]],index);
    }
  }

  setupGeometry(view,projection,pass) {
    const gl=this.gl,u=this.locations;
    gl.useProgram(this.program);
    for (const attribute of Object.values(this.attributes)) gl.enableVertexAttribArray(attribute);
    gl.uniform1i(u.Pass,pass);
    gl.uniform1f(u.Semantic,-1);
    gl.uniform1i(u.Photo,0);
    gl.uniformMatrix4fv(u.View,false,view);
    gl.uniformMatrix4fv(u.Projection,false,projection);
  }

  weather(locations,domain) {
    const gl=this.gl;
    const haze=domain.weather ? domain.haze : domain.night ? [.102,.143,.215] : domain.wet ? [.54,.62,.66] : [.64,.72,.79];
    const fog=domain.weather?.visibility ?? (domain.wet ? domain.fogDistance*1.25 : 169+(domain.field?domain.fogDistance-105:0));
    gl.uniform3fv(locations.Haze,haze);
    gl.uniform3fv(locations.Sun,sun);
    if (locations.Weather) gl.uniform4f(locations.Weather,domain.exposure,fog,domain.wet,domain.warmth);
    gl.uniform1f(locations.Overcast,domain.weather ? Math.max(domain.wet,.76) : domain.wet);
    gl.uniform1i(locations.Night,Number(!!domain.night));
    if (locations.Snow) gl.uniform1f(locations.Snow,Number(!!domain.weather?.snow));
  }

  drawSky(camera,domain,aspect,projected) {
    const gl=this.gl,u=this.skyLocations;
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.skyProgram);
    for (const attribute of Object.values(this.attributes)) gl.disableVertexAttribArray(attribute);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.skyBuffer);
    gl.enableVertexAttribArray(this.skyPoint);
    gl.vertexAttribPointer(this.skyPoint,2,gl.FLOAT,false,0,0);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D,this.materialTextures[3]);
    gl.uniform1i(u.Sky,3);
    const {back,right,up}=basisAt(camera.eye,camera.target);
    const width=Math.tan(radians(camera.fov)/2);
    gl.uniform3fv(u.CameraX,right.map(v => v*width));
    gl.uniform3fv(u.CameraY,up.map(v => v*width/aspect));
    gl.uniform3fv(u.CameraZ,back.map(v => -v));
    this.weather(u,domain);
    this.bindProjection(u,projected);
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.enable(gl.DEPTH_TEST);
  }

  drawRain(aspect,time,intensity,snow) {
    const gl=this.gl;
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ZERO,gl.ONE);
    gl.useProgram(this.rainProgram);
    for (const attribute of Object.values(this.attributes)) gl.disableVertexAttribArray(attribute);
    gl.bindBuffer(gl.ARRAY_BUFFER,this.skyBuffer);
    gl.enableVertexAttribArray(this.rainPoint);
    gl.vertexAttribPointer(this.rainPoint,2,gl.FLOAT,false,0,0);
    gl.uniform1f(this.rainLocations.Aspect,aspect);
    gl.uniform1f(this.rainLocations.Time,time);
    gl.uniform1f(this.rainLocations.Intensity,intensity);
    gl.uniform1f(this.rainLocations.Snow,Number(snow));
    gl.drawArrays(gl.TRIANGLES,0,3);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
  }

  drawShadowMap(state,robotId) {
    if (this.shadowPlayer===state.player&&this.shadowActors===state.actors) return;
    const {frame,width,height}=this.shadow;
    const gl=this.gl;
    const center=[Math.floor(state.player.x/3)*3,3,Math.floor(state.player.z/3)*3];
    const from=center.map((coordinate,index) => coordinate+sun[index]*95);
    const view=viewAt(from,center), projection=ortho(48,3,166);
    this.sunVP=multiply(projection,view);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame);
    gl.viewport(0,0,width,height);
    gl.clearColor(1,1,1,1);
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    this.setupGeometry(view,projection,2);
    // A shadow render cannot sample its own color attachment.
    this.bindMaterials(this.materialTextures[0]);
    gl.uniform1f(this.locations.Time,state.time);
    this.draw(this.urbanCity??this.city);
    this.drawActors(state);
    this.drawRobot(state.player,robotId,state.time);
    this.shadowPlayer=state.player;
    this.shadowActors=state.actors;
  }

  drawScene(engine,camera,{
    frame=null,width,height,depth=false,showRobot=false,showRoute=false,domain=engine.domain,robotId=engine.robotId,
    aspect=width/height,reflecting=false,world=engine.world,staticOnly=false,projected=false,detailed=false,semantic=false,
  }) {
    const gl=this.gl,u=this.locations;
    const color=!depth&&!semantic;
    if (color) this.drawShadowMap(engine,robotId);
    const reflect=color&&!reflecting&&domain.wet>.2;
    if (reflect) {
      const mirror=([x,y,z]) => [x,-y,z];
      const reflected={ ...camera,eye:mirror(camera.eye),target:mirror(camera.target) };
      this.reflectionVP=multiply(perspective(camera.fov,aspect,camera.far),viewAt(reflected.eye,reflected.target));
      const {frame,width,height}=this.reflection;
      this.drawScene(engine,reflected,{frame,width,height,aspect,domain,robotId,world,reflecting:true,
        showRobot,staticOnly,projected,detailed});
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame);
    gl.viewport(0,0,width,height);
    const background=semantic?layoutClass.sky/255:0;
    gl.clearColor(background,background,background,1);
    gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);
    if (color) this.drawSky(camera,domain,aspect,projected);
    this.setupGeometry(viewAt(camera.eye,camera.target),perspective(camera.fov,aspect,camera.far),
      semantic?4:depth?1:reflecting?3:0);
    this.bindMaterials(this.shadow.texture,reflect ? this.reflection.texture : undefined);
    gl.uniform1i(u.Reflect,Number(reflect));
    if (reflect) gl.uniformMatrix4fv(u.ReflectionVP,false,this.reflectionVP);
    this.weather(u,domain);
    if (domain.night&&color) {
      const p=engine.player;
      const [x,z]=forward(p.yaw);
      gl.uniform3fv(u['Lanterns[0]'],this.urbanLanterns??this.lanterns);
      gl.uniform3f(u.Headlamp,p.x+x*.36,p.y+robots[robotId].height*.81,p.z+z*.36);
      gl.uniform3fv(u.Ahead,unit([x,-.15,z]));
    }
    gl.uniform3fv(u.Eye,camera.eye);
    gl.uniformMatrix4fv(u.SunVP,false,this.sunVP ?? new Float32Array(16));
    gl.uniform1f(u.ShadowTexel,1/this.shadow.width);
    gl.uniform1f(u.Time,engine.time);
    this.bindProjection(u,projected&&color&&!reflecting);
    this.draw(this.urbanCity??this.city);
    gl.uniform1i(u.Photo,0);
    if (semantic) gl.uniform1f(u.Semantic,layoutClass.signal);
    for (const {x,z,walk,high,low} of crossingLamps(engine,world)) {
      this.draw(this.markers.light,x,high,z,0,walk?[.23,.29,.26]:[1,.25,.16]);
      this.draw(this.markers.light,x,low,z,0,walk?[.30,1,.59]:[.23,.29,.26]);
      // The lens rings sit outside the wider signal housing on all four sides.
      for (const [dx,dz] of [[-.204,0],[.204,0],[0,-.204],[0,.204]]) {
        this.draw(this.markers.light,x+dx,walk?low:high,z+dz,0,
          walk?[.30,1,.59]:[1,.25,.16],[.56,1,.56]);
      }
    }
    if (!staticOnly) this.drawActors(engine,projected||detailed,semantic);
    if (showRoute) {
      const [gx,gz]=engine.task.points.at(-1);
      this.draw(this.pathBuffer(engine.task,world));
      this.draw(this.markers.goal,gx,world.surfaceAt(gx,gz),gz);
    }
    if (showRobot) {
      if (semantic) gl.uniform1f(u.Semantic,0);  // Cityscapes has no robot class.
      this.drawRobot(engine.player,robotId,engine.time);
    }
    const rain=domain.weather?.rain??(domain.night?1:0);
    if (rain&&color&&!reflecting) this.drawRain(aspect,engine.time,rain,!!domain.weather?.snow);
  }

  drawActors(state,detail=false,semantic=false) {
    for (const actor of state.actors) {
      if (semantic) this.gl.uniform1f(this.locations.Semantic,actorClass[actor.kind]??0);
      const imported=detail&&this.detailedActors.get(actor.kind);
      if (imported) {
        if (actor.kind==='pedestrian') {
          const stride=1.25;
          const phase=actor.speed>0&&actor.progress>0?1+Math.floor(actor.progress/stride*8)%8:0;
          this.draw(imported[phase],actor.x,actor.y,actor.z,actor.yaw);
          continue;
        }
        const rgb=Number.parseInt(actor.color.slice(1),16);
        this.draw(imported[0],actor.x,actor.y,actor.z,actor.yaw,[rgb>>16,(rgb>>8)&255,rgb&255].map(value=>value/255));
        continue;
      }
      const key=actor.kind+actor.color+Number(detail);
      if (!this.actorMeshes.has(key)) this.actorMeshes.set(key,this.upload(actorMesh(actor,{detail})));
      this.draw(this.actorMeshes.get(key),actor.x,actor.y,actor.z,actor.yaw);
      if (actor.kind==='pedestrian') {
        const pose=actor.speed ? Math.round(Math.sin(state.time*9+actor.progress)*2) : 0;
        for (const side of [-1,1]) this.draw(this.legs[2+side*pose],
          actor.x+side*.11*Math.cos(actor.yaw),actor.y,actor.z+side*.11*Math.sin(actor.yaw),actor.yaw);
      }
    }
  }

  drawRobot(player,robotId,time) {
    const {x,y,z,yaw,speed}=player;
    const cycle=Math.sin(time*11)*Math.min(1,Math.abs(speed)*2);
    const pose=this.robotMeshes[robotId][Math.round(cycle*4)+4];
    this.draw(pose,x,y+Math.abs(cycle)*.016,z,yaw);
  }

  displayCamera(engine,mode,sensor,view,{ rawMotion=false }={}) {
    const p=engine.player;
    if (mode==='robot') {
      const viewSensor=sensor ?? engine.sensors.find(item => item.type==='rgb'||item.type==='depth');
      const rig=rigMotion(p,engine.time,engine.domain,engine.world.surfaceAt,engine.world.bounds,Number(rawMotion));
      const original=viewSensor ? sensorPose(p,viewSensor,rig)
        : {x:p.x,y:p.y+engine.robot.height,z:p.z,yaw:p.yaw,pitch:0};
      const {pose,fov}=lookAround(original,viewSensor?.fov??86,view);
      return cameraView(pose,fov,155);
    }
    if (mode==='overhead') return { ...overheadOrbit(p,view),fov:85,far:245 };
    return { ...chaseOrbit(p,view),fov:85,far:196 };
  }

  visibleSignalRegions(engine,camera,aspect) {
    const {back,right,up}=basisAt(camera.eye,camera.target);
    const aperture=Math.tan(radians(camera.fov)/2);
    const regions=[];
    for (const {x,z,walk,high,low} of crossingLamps(engine,engine.world)) {
      const at=[x,(high+low+.21)/2,z].map((value,i)=>value-camera.eye[i]);
      const depth=-dot(back,at);
      if (depth<.65||depth>65) continue;
      const scale=.5/(depth*aperture);
      const px=.5+dot(right,at)*scale,py=.5-dot(up,at)*scale*aspect;
      const halfWidth=.39*scale,halfHeight=.43*scale*aspect;
      if (px+halfWidth<0||px-halfWidth>1||py+halfHeight<0||py-halfHeight>1) continue;
      regions.push([px-halfWidth,py-halfHeight,px+halfWidth,py+halfHeight,walk]);
    }
    return regions.slice(0,20);
  }

  renderDisplay(engine,camera,{width,height,showRobot,showRoute,staticOnly=false,projected=false,detailed=false}) {
    this.selectWorld(engine.world);
    if (this.canvas.width!==width || this.canvas.height!==height) {
      this.canvas.width=width;
      this.canvas.height=height;
    }
    const domain=projected&&this.photo?.look?{...engine.domain,...this.photo.look}:engine.domain;
    this.drawScene(engine,camera,{width,height,showRobot,showRoute,staticOnly,projected,detailed,domain});
  }

  photoGeometry(engine,camera,aspect,{staticOnly=true,detailed=false,showRobot=false}={}) {
    this.selectWorld(engine.world);
    const {gl,target:{frame,width,height}}=this;
    this.drawScene(engine,camera,{frame,width,height,aspect,depth:true,staticOnly,detailed,showRobot});
    const pixels=new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return {pixels,width,height,matrix:multiply(perspective(camera.fov,aspect,camera.far),viewAt(camera.eye,camera.target))};
  }

  semanticGeometry(engine,camera,{width,height,detailed,showRobot}) {
    this.selectWorld(engine.world);
    const gl=this.gl,previous=this.semanticTarget;
    if (!previous||previous.width!==width||previous.height!==height) {
      if (previous) {
        gl.deleteTexture(previous.texture);
        gl.deleteFramebuffer(previous.frame);
        gl.deleteRenderbuffer(previous.depth);
      }
      this.semanticTarget=this.createTarget(width,height);
    }
    this.drawScene(engine,camera,{frame:this.semanticTarget.frame,width,height,semantic:true,detailed,showRobot});
    const pixels=new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    return pixels;
  }

  cameraCalibration(camera,width,height) {
    const {back,right,up}=basisAt(camera.eye,camera.target);
    const focal=width/(2*Math.tan(radians(camera.fov)/2));
    const axes=[right,up.map(value=>-value),back.map(value=>-value)];
    return {intrinsics:[[focal,0,width/2],[0,focal,height/2],[0,0,1]],
      worldToCamera:[...axes.map(axis=>[...axis,-dot(axis,camera.eye)]),[0,0,0,1]]};
  }

  setProjection(image,{pixels,width,height,matrix},style) {
    const gl=this.gl;
    if (this.photo) {
      gl.deleteTexture(this.photo.color);
      gl.deleteTexture(this.photo.depth);
    }
    const color=uploadTexture(gl,image,{mipmaps:false}),depth=gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D,depth);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    const look=/\b(wet|rain\w*)\b|雨|湿/i.test(style)?{wet:.82}:{};
    this.photo={color,depth,matrix,look};
  }

  bindProjection(locations,enabled) {
    const gl=this.gl;
    gl.uniform1i(locations.Photo,Number(!!this.photo&&enabled));
    // Legal sampler assignments are needed even before a reference is ready.
    for (const [unit,name,texture] of [[0,'PhotoColor',this.photo?.color],[1,'PhotoDepth',this.photo?.depth]]) {
      const slot=enabled&&this.photo?unit+7:unit;
      gl.uniform1i(locations[name],slot);
      if (!texture||!enabled) continue;
      gl.activeTexture(gl.TEXTURE0+slot);
      gl.bindTexture(gl.TEXTURE_2D,texture);
    }
    if (enabled&&this.photo) gl.uniformMatrix4fv(locations.PhotoVP,false,this.photo.matrix);
  }

  render(engine,mode,sensor,view,size) {
    const { clientWidth,clientHeight }=this.canvas;
    if (!clientWidth || !clientHeight) return;
    const ratio=Math.min(devicePixelRatio || 1,1.65);
    const { width,height }=size??{ width:Math.round(clientWidth*ratio),height:Math.round(clientHeight*ratio) };
    this.renderDisplay(engine,this.displayCamera(engine,mode,sensor,view),
      { width,height,showRobot:mode!=='robot',showRoute:true });
  }

  grabFrame(state,sensor,pose,domain,robotId,world) {
    this.selectWorld(world);
    const gl=this.gl;
    const { frame,width,height }=this.target;
    const depth=sensor.type==='depth';
    const camera=cameraView(pose,sensor.fov,sensor.range);
    this.drawScene(state,camera,{ frame,width,height,depth,domain,robotId,world });
    const pixels=new Uint8Array(width*height*4);
    gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    if (depth) {
      const data=new Float32Array(width*height);
      for (let i=0; i<data.length; i++) {
        const src=((height-1-Math.floor(i/width))*width+i%width)*4;
        data[i]=(pixels[src]+pixels[src+1]*256+pixels[src+2]*65536)*.001;
      }
      return { width,height,format:'depth-z-m',data };
    }
    const data=new Uint8Array(pixels.length);
    for (let y=0; y<height; y++) data.set(pixels.subarray((height-1-y)*width*4,(height-y)*width*4),y*width*4);
    return { width,height,format:'rgba8',data };
  }
}
