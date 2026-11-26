import { configuredEden,EdenSession } from './eden-session.mjs';
import { guidance } from './navigation.mjs';
import { PhotoView,photoProfile,renderPhoto } from './photo-view.mjs';
import { worldProfile,worldContext,worldFrame } from './reference-world.mjs';
import { referenceStyles } from './reference-styles.mjs';
import { LiveObservation } from './live-observation.mjs';
import { visualState } from './visual-state.mjs';

const labels={ off:'原画',connecting:'正在连接',warming:'等待增强画面',live:'增强',fallback:'已退回原画' };
const parallelSize={ width:1280,height:704 };
const stepMethods=new Set(['cosmos','edge-turbo','sharp']);
const interactiveMethods=new Set(['eden-stream','regen',...stepMethods]);

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
  const benchmark=!!config&&query.has('renderBench');
  const buttons=[...controls.querySelectorAll('[data-eden]')].filter(button=>
    legacy||['original','photo'].includes(button.dataset.eden));
  if (legacy) for (const button of buttons) button.hidden=false;
  const diagnostic=query.has('edenDiagnostics');
  const testReplay=diagnostic&&query.has('edenReplay');
  const contexts=[draft,main].map(canvas=>canvas.getContext('2d',{alpha:false}));
  let mode='original',cameraMode='chase',runMode='ready',scene={},state='off',lastMeta=null;
  let times=[],originalTick=null,profile,world,stream;
  let methods=[],customStyle='';
  let reference=null,appearanceGeneration=0,pendingStyle=null,liveStarted=false;
  let externalLive=null;
  const parallel=()=>cameraMode!=='overhead'&&(mode==='parallel'||query.has('edenCompare')&&
    (liveReference()||regenSelected()||stepReference()));
  const baselineAvailable=()=>cameraMode==='robot'&&(scan||
    benchmark&&profile&&profile.scene===scene.sceneId&&profile.weather===scene.weather&&
    profile.methods.some(method=>method.available));
  const referenceAvailable=()=>cameraMode!=='overhead'&&methods.some(method=>method.available&&referenceMethod(method.id));
  const referenceMethod=id=>world?.methods.find(method=>method.id===id);
  const canShowPhoto=()=>runMode!=='external'&&(baselineAvailable()||referenceAvailable());
  const showPhoto=()=>mode==='photo'&&canShowPhoto();
  const liveSelected=()=>showPhoto()&&methodSelect.value==='eden-stream';
  const liveReference=()=>liveSelected()&&reference?.method==='eden-stream';
  const regenSelected=()=>showPhoto()&&methodSelect.value==='regen';
  const stepReference=()=>showPhoto()&&reference?.method===methodSelect.value&&stepMethods.has(methodSelect.value);
  const projectedSelected=()=>showPhoto()&&methodSelect.value==='projected-photo';
  const projectedReference=()=>projectedSelected()&&reference?.method==='projected-photo';
  const photoLabel=scan?'实景闭环':'写实闭环';
  async function requestPhoto(engine,camera,id,requestStream) {
    if (scan) return renderer.capturePhoto(engine.ticks,camera);
    const method=profile?.methods.find(item=>item.id===id);
    if (!method?.available) throw new Error('当前写实渲染器不可用');
    return renderPhoto(config,{...visualState(engine,camera),method:id,stream:requestStream},
      AbortSignal.timeout((method.timeout+130)*1000));
  }
  const modelLabel=()=>lastMeta?.backend==='passthrough'?'回显':'写实';
  const photoButton=controls.querySelector('[data-eden=photo]');
  const methodSelect=document.getElementById('photo-method');
  const referenceControls=document.getElementById('reference-controls');
  const styleSelect=document.getElementById('reference-style');
  const prompt=document.getElementById('reference-prompt');
  const referenceStart=document.getElementById('reference-start');
  styleSelect.append(...referenceStyles.map(([id,label])=>new Option(label,id)));
  photoButton.textContent=photoLabel;
  function updateReferenceStart() {
    referenceStart.disabled=!prompt.value.trim()||photo.phase==='waiting';
  }
  function photoUpdated() {
    const withReference=!!referenceMethod(methodSelect.value)&&!regenSelected();
    photoButton.hidden=!scan&&!methods.some(method=>method.available);
    photoButton.disabled=!canShowPhoto();
    methodSelect.hidden=!showPhoto()||methodSelect.options.length<2;
    referenceControls.hidden=!showPhoto()||!withReference;
    updateReferenceStart();
    referenceStart.textContent=reference?'重新生成参考帧':'生成参考帧';
    if (!showPhoto()||regenSelected()) return;
    if (liveReference()&&photo.phase==='ready'&&!client.context) {
      client.start({...scene,cameraMode,referenceId:reference.sessionId,referenceSha256:reference.referenceSha256});
    }
    if (liveReference()&&lastMeta) return;
    if (projectedReference()) {
      viewport.removeAttribute('data-eden-live');
      layer.hidden=true;
      status.dataset.state='live';
      status.textContent='参考照片材质 · 同步 CityNav';
      onChange();
      return;
    }
    if (!photo.frame) viewport.removeAttribute('data-eden-live');
    else viewport.setAttribute('data-eden-live','');
    layout();
    layer.hidden=!photo.frame;
    status.dataset.state=photo.phase==='error'?'fallback':photo.phase;
    status.textContent=photo.phase==='error'?(photo.frame?'渲染失败 · 已暂停推进 · 显示上一帧':'渲染失败 · 已暂停推进'):
      photo.phase==='waiting'?
      (withReference&&!reference?'正在生成参考帧':
        photo.frame?'正在渲染下一状态 · 已显示第 '+photo.frame.tick+' 步':'正在渲染当前状态'):
      photo.frame?photoLabel+' · 第 '+photo.frame.tick+' 步'+
        (photo.frame.renderMs>0?' · '+Math.round(photo.frame.renderMs)+' ms':''):
        withReference&&!reference?'输入场景风格并生成参考帧':photoLabel;
    if (photo.phase==='ready') {
      const {tick,key,method,renderMs,capturedAt,captureMs,requestMs}=photo.frame;
      emit('photo-present',{simTick:tick,frameId:key,method,renderMs,capturedAt,captureMs,requestMs,at:performance.now()});
    }
    onChange();
  }
  const photo=new PhotoView(photoUpdated,image=>{
    if (main.width!==image.width||main.height!==image.height) {
      main.width=image.width;
      main.height=image.height;
    }
    contexts[1].drawImage(image,0,0);
  });
  const profileReady=config&&photoProfile(config).then(value=>{
    profile=value;
    options();
    photoUpdated();
  }).catch(()=>{ /* The photo renderer is optional. */ });
  const worldReady=config&&worldProfile(config).then(value=>{
    world=value;
    options();
    photoUpdated();
  }).catch(()=>{ /* The reference service is optional. */ });
  function options() {
    const before=methodSelect.value;
    const referenceMethods=world?.methods??[];
    methods=benchmark?[...referenceMethods.filter(method=>method.id!=='projected-photo'||renderer.photoSupported),
      ...(profile?.methods??[])]:referenceMethods.filter(method=>interactiveMethods.has(method.id)&&method.available);
    methodSelect.replaceChildren(...methods.map(method=>{
      const item=new Option(method.label+(method.available?'':'（未就绪）'),method.id);
      item.disabled=!method.available;
      return item;
    }));
    if (before&&methods.some(method=>method.id===before&&method.available)) methodSelect.value=before;
  }

  function clearReference() {
    appearanceGeneration++;
    reference=null;
    pendingStyle=null;
    liveStarted=false;
  }
  function layout() {
    const sideBySide=parallel();
    viewport.toggleAttribute('data-eden-parallel',sideBySide);
    layer.dataset.mode=sideBySide?'parallel':mode;
    layer.hidden=projectedReference()||!(sideBySide||lastMeta||showPhoto()&&photo.frame);
    draft.nextElementSibling.textContent=sideBySide?'CityNav 原画 · 实时':'源帧';
    main.nextElementSibling.textContent=sideBySide&&stepReference()&&photo.frame?
      referenceMethod(methodSelect.value).label+' · 第 '+photo.frame.tick+' 步':
      lastMeta?(sideBySide?modelLabel():lastMeta.backend==='passthrough'?'回显':'增强'):
      runMode==='paused'?'增强已暂停':state==='fallback'?'增强暂不可用':'等待增强画面';
  }
  const emit=(type,detail)=>{
    if (diagnostic) dispatchEvent(new CustomEvent('citynav-eden',{detail:{...detail,type}}));
  };
  const client=config?new EdenSession(config,{
    status(value,reason) {
      if (value==='warming'&&reason==='regen') renderer.loadDetailedActors(config.endpoint);
      state=value;
      if (value!=='live') {
        delete viewport.dataset.edenAspect;
        if (!liveReference()||!photo.frame||value==='fallback') viewport.removeAttribute('data-eden-live');
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
        contexts[index].drawImage(video,meta.referenceSha256?0:index*width,0,width,height,0,0,width,height);
      });
      const first=lastMeta===null;
      lastMeta=meta;
      if (meta.referenceSha256) liveStarted=true;
      times=times.filter(time=>time>=meta.submittedAt-1000);
      times.push(meta.submittedAt);
      viewport.dataset.edenAspect='fixed';
      viewport.setAttribute('data-eden-live','');
      if (first) layout();
      status.textContent=(meta.referenceSha256?'连续写实':meta.backend==='regen'?'REGEN':
        meta.backend==='passthrough'?'直通自检':meta.tier==='preview'?'增强预览':'增强')+
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
    if (!liveReference()) photo.invalidate();
    stream=null;
    if (!referenceMethod(methodSelect.value)&&!baselineAvailable()&&referenceAvailable()) {
      methodSelect.value=methods.find(method=>method.available&&referenceMethod(method.id)).id;
    }
    if (mode==='photo'&&!canShowPhoto()) mode='original';
    for (const button of buttons) {
      button.disabled=cameraMode==='overhead'&&button.dataset.eden!=='original';
      button.setAttribute('aria-pressed',String(button.dataset.eden===(cameraMode==='overhead'?'original':mode)));
    }
    photoUpdated();
    layout();
    if (liveReference()) return;
    if (regenSelected()&&['ready','running'].includes(runMode)) {
      client.start({...scene,cameraMode,renderer:'regen'});
      return;
    }
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
  methodSelect.addEventListener('change',()=>{
    clearReference();
    if (showPhoto()) restart();
  });
  styleSelect.addEventListener('change',()=>{
    prompt.value=referenceStyles.find(([id])=>id===styleSelect.value)?.[2]??customStyle;
    updateReferenceStart();
  });
  prompt.addEventListener('input',()=>{
    customStyle=prompt.value;
    styleSelect.value='';
    updateReferenceStart();
  });
  referenceStart.addEventListener('click',()=>{
    if (!showPhoto()||!referenceMethod(methodSelect.value)?.available||!prompt.value.trim()) return;
    clearReference();
    if (client?.context) client.stop();
    pendingStyle=prompt.value.trim();
    photo.invalidate();
    photoUpdated();
  });
  for (const button of buttons) button.addEventListener('click',()=>{
    if (mode===button.dataset.eden) {
      if (mode==='photo'&&photo.phase==='error') restart();
      return;
    }
    const switchingLive=!['original','photo'].includes(mode)&&!['original','photo'].includes(button.dataset.eden);
    if (liveReference()) clearReference();
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
  addEventListener('pagehide',()=>{ client?.stop(); externalLive?.close(); });
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
      const contextChanged=scene.episodeId!==next.episodeId||scene.seed!==next.seed||cameraMode!==next.view||
        scene.weather!==next.weather||scene.robotId!==next.robotId||next.reset;
      const changed=contextChanged||runMode!==next.mode&&!startsDriving;
      if (contextChanged) {
        clearReference();
        externalLive?.close();
        externalLive=null;
      }
      scene={ episodeId:next.episodeId,seed:next.seed,weather:next.weather,robotId:next.robotId,sceneId:next.sceneId };
      cameraMode=next.view;
      runMode=next.mode;
      if (changed) restart();
    },
    invalidate() { if (mode!=='original'&&cameraMode!=='overhead') restart(); },
    invalidatePhoto() {
      if (!showPhoto()||referenceMethod(methodSelect.value)) return;
      photo.invalidate();
      stream=null;
      photoUpdated();
    },
    get clocked() { return showPhoto()&&!regenSelected()&&!projectedReference()&&(!liveSelected()||!liveStarted); },
    readyAt(tick) { return !liveSelected()&&photo.ready(tick); },
    async requestPhoto(engine,camera,id,renderStream) {
      await photo.pending;
      await profileReady;
      return requestPhoto(engine,camera,id??'cycles',renderStream);
    },
    async requestWorld(engine,camera,request) {
      await photo.pending;
      await worldReady;
      const dedicated=id=>!['eden-stream','projected-photo','regen'].includes(id);
      const defaultMethod=referenceMethod('cosmos')?.available?'cosmos':
        benchmark?world?.methods.find(item=>item.available&&dedicated(item.id))?.id:undefined;
      const method=request.method??defaultMethod;
      if (!dedicated(method)||!referenceMethod(method)?.available) {
        throw new Error('所选逐步写实渲染器未就绪');
      }
      return worldFrame(config,renderer,engine,camera,worldContext(engine,'robot',scene.weather),{...request,method});
    },
    async openLive(engine,camera,{method='eden-stream',style,styleSeed},observe) {
      await worldReady;
      const regen=method==='regen';
      if ((!regen&&method!=='eden-stream')||!referenceMethod(method)?.available) throw new Error('连续写实渲染器未就绪');
      const context=worldContext(engine,'robot',scene.weather),tick=engine.ticks,generation=appearanceGeneration;
      if (regen) await renderer.loadDetailedActors(config.endpoint);
      const reference=regen?null:await worldFrame(config,renderer,engine,camera,context,{method,style,styleSeed});
      if (runMode!=='external'||engine.ticks!==tick||appearanceGeneration!==generation) {
        throw new Error('建立会话期间仿真状态已改变');
      }
      externalLive?.close();
      externalLive=new LiveObservation(config,{episodeId:context.episode,robotId:context.robot,seed:context.seed,
        weather:context.weather,cameraMode:context.view,...(regen?{renderer:'regen'}:{})},reference,observe);
      const live=externalLive;
      return Object.freeze({referenceSha256:reference?.referenceSha256,next:options=>live.next(options),
        close:()=>{ live.close(); if (externalLive===live) externalLive=null; }});
    },
    get displaying() { return state==='live'&&lastMeta!==null; },
    render(engine,sensor,view,now,dirty,inputRevision) {
      if (externalLive) {
        externalLive.client.capture(now,({width,height})=>{
          const camera=renderer.displayCamera(engine,'robot',null,{yaw:0,pitch:0,zoom:1});
          renderer.renderDisplay(engine,camera,{width,height,showRobot:false,showRoute:false,detailed:true});
          const {signal}=guidance(engine.route,engine.player,engine.time,engine.world.crossings,engine.world.crossingSignal);
          return {image:renderer.canvas,camera,simTick:engine.ticks,inputRevision,signalState:signal?.state,
            signalRegions:renderer.visibleSignalRegions(engine,camera,width/height),local:externalLive.observe()};
        });
      }
      if (projectedReference()) {
        if (dirty) {
          const camera=renderer.displayCamera(engine,cameraMode,null,{yaw:0,pitch:0,zoom:1});
          const {clientWidth,clientHeight}=renderer.canvas;
          const width=Math.max(1,Math.round(clientWidth*devicePixelRatio));
          const height=Math.max(1,Math.round(clientHeight*devicePixelRatio));
          const started=performance.now();
          renderer.renderDisplay(engine,camera,{width,height,showRobot:cameraMode==='chase',
            showRoute:false,projected:true});
          emit('projected-present',{simTick:engine.ticks,inputRevision,at:performance.now(),
            renderMs:performance.now()-started,referenceSha256:reference.referenceSha256});
        }
        return;
      }
      if (showPhoto()&&!liveReference()&&!regenSelected()) {
        if (dirty&&!photo.frame) renderer.render(engine,cameraMode,sensor,view);
        const method=methodSelect.value;
        if (referenceMethod(method)) {
          if (!pendingStyle&&!reference) return;
          const fixed=renderer.displayCamera(engine,cameraMode,null,{yaw:0,pitch:0,zoom:1});
          const context=worldContext(engine,cameraMode,scene.weather),generation=appearanceGeneration;
          photo.capture(engine,async()=>{
            const opening=pendingStyle;
            const geometry=opening&&method==='projected-photo'?renderer.photoGeometry(engine,fixed,1280/704):null;
            const settings=opening?{method,style:opening}:reference;
            const value=await worldFrame(config,renderer,engine,fixed,context,{...settings,
              displayOriginal:stepMethods.has(method)&&query.has('edenCompare')});
            if (geometry) {
              const image=await createImageBitmap(value.image);
              try { if (generation===appearanceGeneration) renderer.setProjection(image,geometry,opening); }
              finally { image.close(); }
            }
            if (generation===appearanceGeneration) {
              reference={method,sessionId:value.sessionId,referenceSha256:value.referenceSha256};
              pendingStyle=null;
            }
            return value;
          });
        } else if (baselineAvailable()) {
          photo.capture(engine,()=>requestPhoto(engine,renderer.displayCamera(engine,cameraMode,sensor,view),
            method,stream??=crypto.randomUUID()));
        }
        return;
      }
      if (!client?.context) {
        if (dirty) renderer.render(engine,cameraMode,sensor,view);
        return;
      }
      const sideBySide=parallel();
      const draw=({width,height},detailed=liveReference()||client.session?.profile?.backend==='regen')=>{
        const camera=liveReference()?renderer.displayCamera(engine,cameraMode,null,{yaw:0,pitch:0,zoom:1}):
          renderer.displayCamera(engine,cameraMode,sensor,view);
        renderer.renderDisplay(engine,camera,{width,height,showRobot:cameraMode==='chase',showRoute:false,detailed});
        return camera;
      };
      const captured=client.capture(now,size=>{
        const camera=draw(sideBySide&&!liveReference()?parallelSize:size);
        const {signal}=guidance(engine.route,engine.player,engine.time,engine.world.crossings,engine.world.crossingSignal);
        const signalRegions=liveReference()?renderer.visibleSignalRegions(engine,camera,size.width/size.height):undefined;
        return {image:renderer.canvas,camera,simTick:engine.ticks,inputRevision,signalState:signal?.state,signalRegions};
      });
      if (sideBySide) {
        if (dirty||captured) {
          if (liveReference()||!captured) draw(parallelSize,false);
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
