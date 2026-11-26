import { semanticControl } from './render-layout.mjs';

function headers(config,extra={}) {
  return config.token?{...extra,Authorization:'Bearer '+config.token}:extra;
}

export async function worldProfile(config) {
  const response=await fetch(config.endpoint+'/world/config',{
    headers:headers(config),cache:'no-store',signal:AbortSignal.timeout(4000),
  });
  if (response.ok) return response.json();
}

export function worldContext(engine,view,weather) {
  return {episode:engine.world.episode?.id??engine.task.id,robot:engine.robotId,
    seed:engine.seed,view,weather};
}

function depthProxy(renderer,engine,camera,aspect,showRobot) {
  const {pixels,width,height}=renderer.photoGeometry(engine,camera,aspect,{staticOnly:false,detailed:true,showRobot});
  const canvas=document.createElement('canvas');
  canvas.width=width;
  canvas.height=height;
  const context=canvas.getContext('2d',{alpha:false});
  const image=context.createImageData(width,height);
  for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
    const source=((height-1-y)*width+x)*4;
    const metres=(pixels[source]+256*pixels[source+1]+65536*pixels[source+2])*.001;
    const value=metres>0?255*Math.sqrt(.65/Math.max(.65,metres)):0;
    const index=(y*width+x)*4;
    image.data[index]=image.data[index+1]=image.data[index+2]=value;
    image.data[index+3]=255;
  }
  context.putImageData(image,0,0);
  return canvas.toDataURL('image/png').split(',')[1];
}

export async function worldFrame(config,renderer,engine,camera,context,{displayOriginal=false,...options}) {
  const key=crypto.randomUUID(),tick=engine.ticks,world=engine.world,capturedAt=performance.now();
  const environment=options.method==='projected-photo';
  const cosmos=options.method==='cosmos';
  const sharp=options.method==='sharp', semantic=sharp||options.method==='edge-turbo';
  const opening=!options.sessionId;
  const [width,height]=cosmos||semantic?[832,480]:['solar','invoker'].includes(options.method)?[1344,768]:[1280,704];
  const showRobot=context.view==='chase'&&!environment;
  const detailed=options.method==='eden-stream'||cosmos||semantic;
  if (detailed||environment) await renderer.loadDetailedActors(config.endpoint);
  if (engine.ticks!==tick||engine.world!==world) throw new Error('采集期间仿真状态已改变');
  renderer.renderDisplay(engine,camera,{width,height,showRobot,
    showRoute:false,staticOnly:environment,detailed});
  const proxy=renderer.canvas.toDataURL('image/png').split(',')[1];
  const geometry={};
  if (cosmos||semantic) geometry.signalRegions=renderer.visibleSignalRegions(engine,camera,width/height);
  if (cosmos) geometry.depth=depthProxy(renderer,engine,camera,width/height,showRobot);
  if (semantic) geometry.labels=semanticControl(renderer,engine,camera,{width,height,showRobot,detailed});
  if (sharp) {
    geometry.calibration=renderer.cameraCalibration(camera,width,height);
    if (opening) {
      renderer.renderDisplay(engine,camera,{width,height,showRobot:false,showRoute:false,staticOnly:true});
      geometry.staticProxy=renderer.canvas.toDataURL('image/png').split(',')[1];
    }
  }
  if (displayOriginal) renderer.renderDisplay(engine,camera,{width,height,showRobot,showRoute:false});
  const captured=performance.now();
  const response=await fetch(config.endpoint+'/world/'+(opening?'start':'frame'),{
    method:'POST',headers:headers(config,{'Content-Type':'application/json'}),
    body:JSON.stringify({key,tick,context,proxy,...geometry,...options}),cache:'no-store',
    signal:AbortSignal.timeout(650_000),
  });
  if (!response.ok) throw new Error((await response.json()).error??'HTTP '+response.status);
  const method=response.headers.get('X-CityNav-Method');
  const sessionId=response.headers.get('X-CityNav-Session');
  const referenceSha256=response.headers.get('X-CityNav-Reference');
  if (response.headers.get('X-CityNav-Frame')!==key||response.headers.get('X-CityNav-Tick')!==String(tick)||
      method!==options.method||!sessionId||!/^[a-f0-9]{64}$/.test(referenceSha256??'')||
      !opening&&(sessionId!==options.sessionId||referenceSha256!==options.referenceSha256)) {
    throw new Error('画面与 CityNav 参考帧会话不匹配');
  }
  const image=await response.blob();
  return {key,tick,method,sessionId,referenceSha256,renderMs:Number(response.headers.get('X-CityNav-Render-Ms')),
    image,capturedAt,captureMs:captured-capturedAt,requestMs:performance.now()-captured};
}

