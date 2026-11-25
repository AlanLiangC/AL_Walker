import { configuredEden,EdenSession } from './eden-session.mjs';
import { guidance } from './navigation.mjs';
import { PhotoView,photoProfile,renderPhoto } from './photo-view.mjs';
import { visualState } from './visual-state.mjs';

const labels={ off:'原画',connecting:'正在连接',warming:'等待增强画面',live:'增强',fallback:'已退回原画' };
const parallelSize={ width:1280,height:704 };

export function bindEdenView(renderer,onChange,{scan=false}={}) {
  const config=scan?null:configuredEden();
  if (!scan&&!config) return null;
  const viewport=document.getElementById('viewport');
  const controls=document.getElementById('eden-controls');
  const status=document.getElementById('eden-status');
  const layer=document.getElementById('eden-output');
  const draft=document.getElementById('eden-draft');
  const main=document.getElementById('eden-main');
  const query=new URLSearchParams(location.search);
  const legacy=!!config&&query.get('edenLegacy')==='1';
  const buttons=[...controls.querySelectorAll('[data-eden]')].filter(button=>
    legacy||['original','photo'].includes(button.dataset.eden));
  if (legacy) for (const button of buttons) button.hidden=false;
  const diagnostic=query.has('edenDiagnostics');
  const testReplay=diagnostic&&query.has('edenReplay');
  const contexts=[draft,main].map(canvas=>canvas.getContext('2d',{alpha:false}));
  let mode='original',cameraMode='chase',runMode='ready',scene={},state='off',lastMeta=null;
  let times=[],originalTick=null,profile;
  const parallel=()=>mode==='parallel'&&cameraMode!=='overhead';
  const canShowPhoto=()=>runMode!=='external'&&cameraMode==='robot'&&
    (scan||!!profile&&profile.scene===scene.sceneId&&profile.weather===scene.weather);
  const showPhoto=()=>mode==='photo'&&canShowPhoto();
  const photoLabel=scan?'实景闭环':'写实闭环';
  const requestPhoto=(engine,camera)=>scan?renderer.capturePhoto(engine.ticks,camera):
    renderPhoto(config,visualState(engine,camera),AbortSignal.timeout(130_000));
  const modelLabel=()=>lastMeta?.backend==='passthrough'?'回显':'写实';
  const photoButton=controls.querySelector('[data-eden=photo]');
  photoButton.textContent=photoLabel;
  function photoUpdated() {
    photoButton.hidden=!scan&&!profile;
    photoButton.disabled=!canShowPhoto();
    if (!showPhoto()) return;
    if (!photo.frame) viewport.removeAttribute('data-eden-live');
    else viewport.setAttribute('data-eden-live','');
    layer.hidden=!photo.frame;
    status.dataset.state=photo.phase==='error'?'fallback':photo.phase;
    status.textContent=photo.phase==='error'?(photo.frame?'渲染失败 · 已暂停推进 · 显示上一帧':'渲染失败 · 已暂停推进'):
      photo.phase==='waiting'?
      (photo.frame?'正在渲染下一状态 · 已显示第 '+photo.frame.tick+' 步':'正在渲染当前状态'):
      photo.frame?photoLabel+' · 第 '+photo.frame.tick+' 步 · '+Math.round(photo.frame.renderMs)+' ms':photoLabel;
    if (photo.phase==='ready') emit('photo-present',{simTick:photo.frame.tick,frameId:photo.frame.key,
      renderMs:photo.frame.renderMs,at:performance.now()});
    onChange();
  }
  const photo=new PhotoView(photoUpdated,image=>{
    if (main.width!==image.width||main.height!==image.height) {
      main.width=image.width;
      main.height=image.height;
    }
    contexts[1].drawImage(image,0,0);
  });
  if (config) photoProfile(config).then(value=>{
    profile=value;
    photoUpdated();
  }).catch(()=>{ /* The photo renderer is optional. */ });
  function layout() {
    const sideBySide=parallel();
    viewport.toggleAttribute('data-eden-parallel',sideBySide);
    layer.dataset.mode=mode;
    layer.hidden=!(sideBySide||lastMeta||showPhoto()&&photo.frame);
    draft.nextElementSibling.textContent=sideBySide?'CityNav 原画 · 实时':'源帧';
    main.nextElementSibling.textContent=lastMeta ? (sideBySide?modelLabel():lastMeta.backend==='passthrough'?'回显':'增强')
      : runMode==='paused'?'增强已暂停':state==='fallback'?'增强暂不可用':'等待增强画面';
  }
  const emit=(type,detail)=>{
    if (diagnostic) dispatchEvent(new CustomEvent('citynav-eden',{detail:{...detail,type}}));
  };
  const client=legacy?new EdenSession(config,{
    status(value,reason) {
      state=value;
      if (value!=='live') {
        delete viewport.dataset.edenAspect;
        viewport.removeAttribute('data-eden-live');
        lastMeta=null;
        times=[];
      }
      layout();
      status.dataset.state=value;
      status.textContent=value==='off'&&cameraMode==='overhead'?'俯视 · 原画':
        labels[value]+(reason&&value==='fallback'?' · '+reason:'');
      emit('status',{state:value,reason,at:performance.now(),mode,cameraMode,weather:scene.weather});
      onChange();
    },
    present(video,meta,{width,height}) {
      [draft,main].forEach((canvas,index)=>{
        if (index===0&&mode!=='compare') return;
        if (canvas.width!==width||canvas.height!==height) {
          canvas.width=width;
          canvas.height=height;
        }
        contexts[index].drawImage(video,index*width,0,width,height,0,0,width,height);
      });
      const first=lastMeta===null;
      lastMeta=meta;
      times=times.filter(time=>time>=meta.submittedAt-1000);
      times.push(meta.submittedAt);
      viewport.dataset.edenAspect='fixed';
      viewport.setAttribute('data-eden-live','');
      if (first) layout();
      status.textContent=(meta.backend==='passthrough'?'直通自检':meta.tier==='preview'?'增强预览':'增强')+
        ' · '+times.length+' FPS · '+(parallel()?'延迟 ':'')+Math.round(meta.ageMs)+' ms';
      const canvasSubmittedAt=performance.now();
      emit('present',{...meta,videoSubmittedAt:meta.submittedAt,submittedAt:canvasSubmittedAt,
        ageMs:canvasSubmittedAt-meta.input.capturedAt,...(parallel()?{originalTick}:{})});
    },
    input:input=>emit('input',input),
    drop:output=>emit('drop',output),
    unpaired:output=>emit('unpaired',output),
    stats:diagnostic?data=>emit('rtc-stats',data):undefined,
  }):null;

  function restart() {
    photo.invalidate();
    if (mode==='photo'&&!canShowPhoto()) mode='original';
    for (const button of buttons) {
      button.disabled=cameraMode==='overhead'&&button.dataset.eden!=='original';
      button.setAttribute('aria-pressed',String(button.dataset.eden===(cameraMode==='overhead'?'original':mode)));
    }
    photoUpdated();
    layout();
    if (mode!=='original'&&mode!=='photo'&&cameraMode!=='overhead'&&
        (['ready','running'].includes(runMode)||testReplay&&runMode==='external')) {
      client?.start({...scene,cameraMode});
    } else {
      if (client) client.stop();
      else if (mode==='original') {
        viewport.removeAttribute('data-eden-live');
        status.dataset.state='off';
        status.textContent='原画';
        onChange();
      }
      photoUpdated();
      if (runMode==='paused'&&mode!=='original'&&cameraMode!=='overhead') status.textContent='已暂停 · 原画';
    }
  }
  for (const button of buttons) button.addEventListener('click',()=>{
    if (mode===button.dataset.eden) {
      if (mode==='photo'&&photo.phase==='error') restart();
      return;
    }
    const switchingLive=!['original','photo'].includes(mode)&&!['original','photo'].includes(button.dataset.eden);
    mode=button.dataset.eden;
    if (!switchingLive) return restart();
    if (mode==='compare') {
      viewport.removeAttribute('data-eden-live');
      lastMeta=null;
    }
    layout();
    onChange();
    for (const tab of buttons) tab.setAttribute('aria-pressed',String(tab.dataset.eden===mode));
  });
  addEventListener('pagehide',()=>client?.stop());
  addEventListener('offline',()=>{
    if (client?.session) client.fail(client.session,'网络中断');
  });
  addEventListener('online',()=>{
    if (showPhoto()&&photo.phase==='error') restart();
    if (mode!=='original'&&mode!=='photo'&&cameraMode!=='overhead') restart();
  });
  controls.hidden=false;
  restart();

  return {
    update(next) {
      const startsDriving=runMode==='ready'&&next.mode==='running';
      const changed=scene.episodeId!==next.episodeId||scene.seed!==next.seed||cameraMode!==next.view||
        scene.weather!==next.weather||scene.robotId!==next.robotId||runMode!==next.mode&&!startsDriving||next.reset;
      scene={ episodeId:next.episodeId,seed:next.seed,weather:next.weather,robotId:next.robotId,sceneId:next.sceneId };
      cameraMode=next.view;
      runMode=next.mode;
      if (changed) restart();
    },
    invalidate() { if (mode!=='original'&&cameraMode!=='overhead') restart(); },
    invalidatePhoto() {
      if (!showPhoto()) return;
      photo.invalidate();
      photoUpdated();
    },
    get clocked() { return showPhoto(); },
    readyAt(tick) { return photo.ready(tick); },
    async requestPhoto(engine,camera) {
      await photo.pending;
      return requestPhoto(engine,camera);
    },
    get displaying() { return state==='live'&&lastMeta!==null; },
    render(engine,sensor,view,now,dirty,inputRevision) {
      if (showPhoto()) {
        if (dirty&&!photo.frame) renderer.render(engine,cameraMode,sensor,view);
        photo.capture(engine,()=>requestPhoto(engine,renderer.displayCamera(engine,cameraMode,sensor,view)));
        return;
      }
      if (!client) {
        if (dirty) renderer.render(engine,cameraMode,sensor,view);
        return;
      }
      const sideBySide=parallel();
      const draw=({width,height})=>{
        const camera=renderer.displayCamera(engine,cameraMode,sensor,view);
        renderer.renderDisplay(engine,camera,{ width,height,showRobot:cameraMode==='chase',showRoute:false });
        return camera;
      };
      const captured=client.capture(now,size=>{
        const camera=draw(sideBySide?parallelSize:size);
        const {signal}=guidance(engine.route,engine.player,engine.time,engine.world.crossings,engine.world.crossingSignal);
        return { image:renderer.canvas,camera,simTick:engine.ticks,inputRevision,signalState:signal?.state };
      });
      if (sideBySide) {
        if (dirty&&!captured) draw(parallelSize);
        if (dirty||captured) {
          originalTick=engine.ticks;
          emit('parallel-original',{simTick:originalTick,at:performance.now()});
        }
        return;
      }
      if ((dirty||captured)&&!this.displaying) {
        const size=client.session?.capture;
        if (size&&captured) {
          viewport.dataset.edenAspect='fixed';
        }
        renderer.render(engine,cameraMode,sensor,view,size);
      }
    },
  };
}
