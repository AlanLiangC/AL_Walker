import { alleyWorld } from './alley-world.mjs';
import { CityEngine, MIN_SAFETY, STEP_SECONDS } from './engine.mjs';
import { domainProfiles } from './domain.mjs';
import { drawMap } from './minimap.mjs';
import { CityRenderer } from './renderer.mjs';
import { loadCityTextures } from './materials.mjs';
import { CROSSING_SPEED } from './rules.mjs';
import { robots, sensorTypes } from './sensors.mjs';
import { option, setupEditor } from './configuration.mjs';
import { benchmarkVersion, challengeCatalog, challengeVersion, episodeCatalog, findEpisode, sceneCatalog } from './scene-families.mjs';
import { describeUrbanEpisode } from './urban-episode.mjs';
import { bindViewControls } from './view-controls.mjs';
import { bindEdenView } from './eden-view.mjs';
import { visualWeather } from './visual-state.mjs';

const $=id => document.getElementById(id);
const label=(id,text) => {
  if ($(id).textContent!==text) $(id).textContent=text;
};
const clock = seconds => {
  const whole=Math.ceil(seconds-1e-7);
  return [Math.floor(whole/60),whole%60].map(value => String(value).padStart(2,'0')).join(':');
};

async function boot() {
  const source=document.body.hasAttribute('data-source');
  const query=new URLSearchParams(location.search);
  const scan=document.body.dataset.world==='scan' || source&&query.get('scene')==='scan';
  const initialEpisode=source ? findEpisode(query.get('episode'))?.id : null;
  const engine=new CityEngine({ recordTrajectory:true,episodeId:scan?undefined:initialEpisode??'boulevard-01-e02' },
    scan?alleyWorld:undefined);
  const sceneSwitch=$('scene-switch');
  if (scan) {
    label('configure','任务配置');
    label('setup-title','任务配置');
    sceneSwitch.hidden=false;
    document.title='CityNav | Artillery Passage 实景任务';
    sceneSwitch.href=source?'./':'index.html';
    sceneSwitch.textContent='模拟城市';
    document.querySelector('[data-view="overhead"]').hidden=true;
    $('scan-credit').hidden=false;
  }
  const renderer=scan
    ? await (await import('./scan-renderer.mjs')).ScanRenderer.create($('scene'),message => label('scene-loading',message))
    : new CityRenderer($('scene'),await loadCityTextures());
  const keys=new Set(), frameKeys=new Set(), pointers=new Map();
  const views=[...document.querySelectorAll('[data-view]:not([hidden])')];
  const maps=[...document.querySelectorAll('[data-map]')];
  let mode='ready',view='chase',mapMode='overview',snap;
  let dirty=true,accumulator=0,last=0,lastHud=-1,lastSensor=-1,shownEvents=-1,noticeCreatedAt=-Infinity;
  let touchSlow=false,inputRevision=0,appliedRevision=0;
  let worldRevision=0,renderedPending=false,renderedLease=null,renderedStream=null,renderedWorld=null;
  const eden=bindEdenView(renderer,()=>{ dirty=true; },{scan});
  const cameraControls=bindViewControls($('scene'),()=>{
    dirty=true;
    appliedRevision=++inputRevision;
    eden?.invalidatePhoto();
  });
  const renderSensorFrame=(state,sensor,pose) => renderer.grabFrame(state,sensor,pose,engine.domain,engine.robotId,engine.world);

  function updateEden(reset=false) {
    eden?.update({ view,mode,reset,episodeId:engine.world.episode?.id??engine.task.id,
      sceneId:engine.world.episode?.sceneId,seed:engine.seed,robotId:engine.robotId,weather:visualWeather(engine.domain) });
  }

  function resetView() {
    cameraControls.reset();
    eden?.invalidate();
  }

  function clearInput() {
    keys.clear();
    frameKeys.clear();
    for (const [,button] of pointers) button.classList.remove('held');
    pointers.clear();
  }

  function selectTab(buttons,key,value) {
    for (const button of buttons) button.setAttribute('aria-pressed',String(button.dataset[key]===value));
  }

  function selectedSensor() {
    return engine.sensors.find(item => item.id===$('sensor-choice').value);
  }

  function setView(value) {
    view=value;
    selectTab(views,'view',view);
    cameraControls.select(view);
    updateEden();
  }

  function setMode(value,reset=false) {
    mode=value;
    clearInput();
    accumulator=0;
    const status=mode==='external' ? '模型控制' : mode==='ready' ? '待出发' : mode==='paused' ? '已暂停'
      : mode==='finished' ? (engine.status==='success'?'已完成':'未通过') : '进行中';
    $('run-state').dataset.state=mode==='finished' ? engine.status : mode;
    $('run-state').querySelector('span').textContent=status;
    const command=({ ready:'开始任务',paused:'继续任务',running:'暂停',finished:'重试任务',external:'接管任务' })[mode];
    label('run',command);
    label('fullscreen-run',command);
    $('return-to-start').disabled=mode==='ready';
    $('fullscreen-return-to-start').disabled=mode==='ready';
    dirty=true;
    updateEden(reset);
  }

  function config() {
    return { taskId:engine.task.id,robotId:engine.robotId,seed:engine.seed,domain:engine.domain.id,
      ...(engine.world.episode?{episodeId:engine.world.episode.id,sceneId:engine.world.episode.sceneId}:{}),
      sensors:structuredClone(engine.sensors),recordTrajectory:engine.trajectoryRows!==null };
  }

  function refreshTask() {
    const task=engine.task;
    const domain=engine.domain;
    label('domain-label',scan?'伦敦 Spitalfields · 3D 实景':
      (engine.world.layout?.name??'室外导航评测')+' · '+domainProfiles[domain.id].name);
    const sky=domain.sky.map(v => Math.round(v*255));
    $('viewport').style.background=domain.field
      ? `linear-gradient(rgb(${sky.join(',')}) 0%, rgb(${domain.haze.map(v => Math.round(v*255)).join(',')}) 85%)` : '';
    const episode=engine.world.episode;
    const taskName=episode?episode.id.split('-').at(-1).toUpperCase()+' · '+task.name:task.name;
    for (const [id,value] of Object.entries({ 'task-name':taskName,'route-from':task.from,'route-to':task.to,
      'map-start':task.from,'map-end':task.to,'robot-name':engine.robot.name })) label(id,value);
    const choice=$('sensor-choice');
    const former=choice.value;
    choice.replaceChildren(...engine.sensors.map(item => option(item.id,sensorTypes[item.type]+' · '+item.id)));
    if (engine.sensors.some(item => item.id===former)) choice.value=former;
    choice.disabled=!engine.sensors.length;
    shownEvents=-1;
    noticeCreatedAt=-Infinity;
    $('notice').hidden=true;
    lastSensor=-1;
    updateHud(performance.now());
  }

  function reset(next,nextMode) {
    engine.reset(next);
    worldRevision++;
    renderedLease=null;
    renderedStream=null;
    renderedWorld=null;
    if ($('result').open) $('result').close();
    setMode(nextMode,true);
    refreshTask();
    return snap;
  }

  function step(action,ticks=1) {
    snap=engine.step(action,ticks);
    appliedRevision=inputRevision;
    dirty=true;
    return snap;
  }

  function focusDriving() {
    $('viewport').focus({ preventScroll:true });
  }

  function actionFromInput() {
    const held=(...codes) => codes.some(code => keys.has(code)||frameKeys.has(code)||
      [...pointers.values()].some(button => button.dataset.key===code));
    const cruise=held('ShiftLeft','ShiftRight')||touchSlow ? .78/engine.robot.speed : 1;
    return {
      throttle:(Number(held('KeyW','ArrowUp'))-Number(held('KeyS','ArrowDown')))*cruise,
      turn:Number(held('KeyD','ArrowRight'))-Number(held('KeyA','ArrowLeft')),
      brake:held('Space'),
    };
  }

  function updateHud(now) {
    snap=engine.snapshot();
    const nav=snap.navigation;
    label('maneuver-icon',nav.symbol);
    label('maneuver-title',nav.instruction);
    label('maneuver-distance',Math.ceil(nav.maneuverDistance)+' m');
    label('timer',clock(snap.remainingTime));
    label('score',String(snap.score));
    label('speed',Math.abs(snap.player.speed).toFixed(2));
    label('remaining',String(Math.ceil(nav.remaining)));
    label('immersive-stats',clock(snap.remainingTime)+' · '+Math.abs(snap.player.speed).toFixed(2)+' m/s · '+snap.score+' 分');
    label('eta','约 '+Math.max(1,Math.ceil(nav.etaSeconds/60))+' 分钟');
    $('timer').dataset.low=String(snap.remainingTime<20);
    $('score').dataset.low=String(snap.score<MIN_SAFETY);
    const signal=nav.signal;
    $('signal').dataset.state=signal?.state ?? '';
    const signalSpeed=(signal?.speed??CROSSING_SPEED)+' m/s';
    label('signal-state',signal ? ({
      walk:'可通行',stop:'停止等候',yield:'减速观察','full-stop':snap.context.stopReady?'已停稳，观察后通行':'在黄线前停稳约半秒',
    })[signal.state] : (snap.context.yieldTarget?'注意礼让':'沿人行路线前进'));
    const crossingDistance=engine.world.episode&&signal?.distance>2 ? ' · '+Math.ceil(signal.distance)+' m 后' : '';
    label('signal-name',signal ? signal.name+' · '+signalSpeed+crossingDistance
      : (snap.context.zone?snap.context.zone+' · ':'当前限速 ')+snap.context.speedLimit.toFixed(2)+' m/s');
    label('signal-count',signal && signal.remaining!=null ? Math.ceil(signal.remaining)+' 秒' : '');
    $('compact-signal').hidden=!signal;
    $('compact-signal').dataset.state=signal?.state ?? '';
    label('compact-signal',[$('signal-state').textContent,$('signal-count').textContent,signal && '限速 '+signalSpeed].filter(Boolean).join(' · '));
    if (snap.events.length!==shownEvents) {
      if (shownEvents>=0 && snap.events.length) {
        const event=snap.events.at(-1);
        label('notice',event.label+'  −'+event.points);
        noticeCreatedAt=now;
      }
      shownEvents=snap.events.length;
      const events=$('event-list');
      events.replaceChildren();
      const records=[...snap.events].reverse();
      if (!records.length) {
        const item=document.createElement('li');
        item.textContent='暂无碰撞或交通违规。';
        events.append(item);
      }
      for (const event of records.slice(0,30)) {
        const item=document.createElement('li');
        const time=document.createElement('time');
        const title=document.createElement('strong');
        const loss=document.createElement('b');
        time.textContent=clock(event.time);
        title.textContent=event.label;
        loss.textContent='−'+event.points;
        if (event.detail) item.title=event.detail;
        item.append(time,title,loss);
        events.append(item);
      }
    }
    $('notice').hidden=now-noticeCreatedAt>2600;
    label('event-count',snap.events.length+' 条');
    drawMap($('map'),$('map-scale'),engine,mapMode);
    lastHud=now;
  }

  function drawSensors(now) {
    if ($('sensor-panel').hidden) return;
    const sensor=selectedSensor();
    const canvas=$('sensor-image');
    if (!sensor) {
      canvas.hidden=true;
      return label('sensor-data','当前机器人未安装传感器。');
    }
    const observation=engine.sampleSensors([sensor],renderSensorFrame)[0];
    canvas.hidden=!observation.available || !['rgb','depth','lidar'].includes(sensor.type);
    const number=value => value.toFixed(2);
    let data='安装  '+[sensor.forward,sensor.right,sensor.height].map(number).join(' / ')+' m\n';
    data+='姿态  '+sensor.yaw+'° 偏航 / '+sensor.pitch+'° 俯仰\n';
    data+='采样  '+observation.rateHz+' Hz · 延迟 '+observation.latencyMs+' ms';
    lastSensor=now;
    if (!observation.available) return label('sensor-data',data+'\n等待首个样本');
    data+='\n时间戳  '+number(observation.sampleTime)+' s';
    const ctx=canvas.getContext('2d');
    const w=canvas.width,h=canvas.height;
    if (sensor.type==='rgb'||sensor.type==='depth') {
      const frame=observation.frame;
      const image=ctx.createImageData(w,h);
      if (sensor.type==='rgb') image.data.set(frame.data);
      else {
        for (let i=0; i<frame.data.length; i++) {
          const distance=frame.data[i];
          const strength=distance ? 1-Math.min(1,distance/sensor.range) : 0;
          image.data.set([20+130*strength,30+194*strength,44+143*strength,255],i*4);
        }
      }
      ctx.putImageData(image,0,0);
      data+='\n分辨率  '+frame.width+' × '+frame.height+'\n量程  '+sensor.range+' m';
      if (frame.geometry==='collision-proxy') data+='\n深度来源  碰撞几何';
    } else if (sensor.type==='lidar') {
      ctx.fillStyle='#172a24';
      ctx.fillRect(0,0,w,h);
      const center=[w/2,h/2],scale=(h/2-8)/sensor.range;
      ctx.strokeStyle='#466354';
      for (const radius of [.25,.5,.75,1]) {
        ctx.beginPath();
        ctx.arc(...center,sensor.range*scale*radius,0,Math.PI*2);
        ctx.stroke();
      }
      for (const [i,range] of observation.ranges.entries()) {
        const angle=observation.angleMin+i*observation.angleStep;
        const [x,y]=[center[0]+range*Math.sin(angle)*scale,center[1]-range*Math.cos(angle)*scale];
        ctx.fillStyle=range<sensor.range?'#9eebbf':'#537966';
        ctx.fillRect(x-1,y-1,2,2);
      }
      ctx.fillStyle='#ffffff';
      ctx.fillRect(center[0]-2,center[1]-2,4,4);
      data+='\n扫描  '+sensor.rays+' 束 / '+sensor.fov+'°\n量程  '+sensor.range+' m';
    } else if (sensor.type==='imu') {
      data+='\n角速度  '+observation.angularVelocity.map(number).join(' / ')+' rad/s';
      data+='\n比力  '+observation.specificForce.map(number).join(' / ')+' m/s²';
    } else if (sensor.type==='gps') {
      data+=observation.fix ? '\n本地坐标  '+observation.localPosition.map(number).join(' / ')+' m' : '\n当前样本无定位';
    }
    label('sensor-data',data);
  }

  function conclude() {
    setMode('finished');
    if (document.fullscreenElement===$('viewport')) document.exitFullscreen().catch(console.error);
    const { reason,time,score,traveled,events }=engine.snapshot();
    const critical=events.filter(event => event.critical).length;
    label('result-task',engine.task.name);
    label('result-title',({ arrived:'安全抵达',timeout:'任务超时',unsafe:'已抵达，安全评估未通过' })[reason]);
    label('result-detail',reason==='timeout' ? '在任务时限内未抵达 '+engine.task.to+'。'
      : reason==='unsafe' ? '本次记录包含 '+critical+' 次严重事件。通过须达到 '+MIN_SAFETY+' 分，且无碰撞及严重违规。'
      : '机器人按时抵达 '+engine.task.to+'，通过安全评估。');
    $('result-metrics').replaceChildren(...[clock(time)+' 用时',score+' 安全分',traveled.toFixed(1)+' m 行程',events.length+' 条事件']
      .map(text => Object.assign(document.createElement('span'),{textContent:text})));
    if (!$('setup').open && !$('result').open) $('result').showModal();
  }

  function runButton() {
    if (mode==='ready') setMode('running');
    else if (mode==='finished'||engine.status!=='running') reset(config(),'running');
    else setMode(mode==='running'?'paused':'running');
    if (mode==='running') focusDriving();
  }

  function returnToStart() {
    reset(config(),'ready');
    if (document.fullscreenElement===$('viewport')) $('fullscreen-run').focus({ preventScroll:true });
    else $('run').focus({ preventScroll:true });
  }

  const openSetup=setupEditor((next,start) => {
    reset({ ...next,recordTrajectory:true },start?'running':'ready');
    $('setup').close();
    if (start) focusDriving();
    else $('run').focus({ preventScroll:true });
  },engine.baseWorld);
  label('pass-condition',scan
    ? '在时限内进入终点绿圈，安全分至少 '+MIN_SAFETY+'，且无任何碰撞。'
    : '在时限内进入终点绿圈，安全分至少 '+MIN_SAFETY+'，且无碰撞、闯红灯、违规穿越机动车道或闯入施工区。');
  $('configure').addEventListener('click',() => {
    if (mode==='running') setMode('paused');
    openSetup(engine);
  });
  $('run').addEventListener('click',runButton);
  $('fullscreen-run').addEventListener('click',runButton);
  $('return-to-start').addEventListener('click',returnToStart);
  $('fullscreen-return-to-start').addEventListener('click',returnToStart);
  async function toggleFullscreen() {
    if (!document.fullscreenEnabled) return;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $('viewport').requestFullscreen();
    } catch (error) {
      console.error(error);
    }
  }
  $('fullscreen').hidden=!document.fullscreenEnabled;
  $('fullscreen').addEventListener('click',toggleFullscreen);
  document.addEventListener('fullscreenchange',() => {
    const active=document.fullscreenElement===$('viewport');
    $('fullscreen').setAttribute('aria-pressed',String(active));
    label('fullscreen',active ? '退出全屏' : '全屏');
    if (active) focusDriving();
    dirty=true;
  });
  $('retry').addEventListener('click',() => { reset(config(),'running'); focusDriving(); });
  $('export').addEventListener('click',() => {
    const report={ ...(engine.world.episode?{benchmarkVersion}:{}),
      ...(engine.world.episode?.difficulty==='extreme'?{challengeVersion}:{}),
      config:config(),final:engine.snapshot(),trajectory:engine.trajectory() };
    const url=URL.createObjectURL(new Blob([JSON.stringify(report)],
      { type:'application/json' }));
    const file=document.createElement('a');
    file.href=url;
    file.download='citynav-'+engine.task.id+'-'+engine.seed+'.json';
    file.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click',() => $(button.dataset.close).close()));
  for (const button of views) button.addEventListener('click',() => setView(button.dataset.view));
  $('reset-view').addEventListener('click',resetView);
  $('scene').addEventListener('dblclick',()=>eden?.invalidate());
  for (const button of maps) button.addEventListener('click',() => {
    mapMode=button.dataset.map;
    selectTab(maps,'map',mapMode);
    dirty=true;
  });
  $('open-sensors').addEventListener('click',() => {
    const panel=$('sensor-panel');
    panel.hidden=!panel.hidden;
    $('open-sensors').setAttribute('aria-expanded',String(!panel.hidden));
    lastSensor=-1;
    if (!panel.hidden&&!renderer.capturing) drawSensors(performance.now());
  });
  $('sensor-choice').addEventListener('change',() => { lastSensor=-1; dirty=true; if (view==='robot') eden?.invalidate(); });
  $('touch-slow').addEventListener('click',() => {
    touchSlow=!touchSlow;
    $('touch-slow').setAttribute('aria-pressed',String(touchSlow));
  });

  const driveKeys=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space']);
  const allKeys=new Set([...driveKeys,'ShiftLeft','ShiftRight','KeyC','KeyF','KeyV','Escape']);
  addEventListener('keydown',event => {
    if (event.target.matches('input, select, textarea, button') && (event.code==='Space' || event.target.matches('input, select, textarea'))) return;
    if (!allKeys.has(event.code)||$('setup').open||$('result').open||event.altKey||event.metaKey||event.ctrlKey) return;
    if (event.code==='KeyF' && !event.repeat) return toggleFullscreen();
    if (event.code==='KeyV' && !event.repeat) return resetView();
    if (event.code==='Escape' && !event.repeat && ['paused','running'].includes(mode)) return runButton();
    if (event.code==='KeyC' && !event.repeat) return setView(views[(views.findIndex(btn => btn.dataset.view===view)+1)%views.length].dataset.view);
    if (mode!=='running') return;
    if (event.target.matches('button')) focusDriving();
    if (!keys.has(event.code)) {
      inputRevision++;
      if (eden?.clocked&&driveKeys.has(event.code)) frameKeys.add(event.code);
    }
    keys.add(event.code);
    event.preventDefault();
  });
  addEventListener('keyup',event => { if (keys.delete(event.code)) inputRevision++; });
  addEventListener('blur',() => { if (mode==='running') setMode('paused'); else clearInput(); });
  for (const button of document.querySelectorAll('[data-key]')) {
    button.addEventListener('pointerdown',event => {
      event.preventDefault();
      if (mode!=='running') return;
      button.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId,button);
      if (eden?.clocked) frameKeys.add(button.dataset.key);
      inputRevision++;
      button.classList.add('held');
    });
    function release(event) {
      if (pointers.delete(event.pointerId)) inputRevision++;
      if (![...pointers.values()].includes(button)) button.classList.remove('held');
    }
    button.addEventListener('lostpointercapture',release);
    button.addEventListener('pointerup',release);
    button.addEventListener('pointercancel',release);
  }
  new ResizeObserver(() => { dirty=true; }).observe($('viewport'));
  new ResizeObserver(() => { dirty=true; }).observe($('map'));

  const domains=Object.fromEntries((engine.world.profiles ?? Object.keys(domainProfiles)).map(id => [id,domainProfiles[id]]));
  const catalog=Object.freeze({ tasks:structuredClone(engine.baseWorld.tasks),robots:structuredClone(robots),sensors:{...sensorTypes},
    domains:structuredClone(domains),stepSeconds:STEP_SECONDS,
    ...(scan?{}:{benchmarkVersion,challengeVersion,scenes:structuredClone(sceneCatalog),episodes:structuredClone(episodeCatalog),
      challenges:structuredClone(challengeCatalog),
      describeEpisode:describeUrbanEpisode}) });
  function requireExternal() {
    if (mode!=='external') throw new Error('请先调用 reset() 以进入模型控制');
  }
  function policyObservation({ frames=false }={}) {
    return engine.observePolicy(frames ? renderSensorFrame : undefined);
  }
  async function renderedObservation({method,style,styleSeed}={}) {
    requireExternal();
    if (!eden) throw new Error('当前入口没有写实渲染端点');
    if (renderedPending) throw new Error('已经在等待一帧写实观测');
    const revision=worldRevision,tick=engine.ticks;
    renderedPending=true;
    renderedLease=null;
    try {
      const camera=renderer.displayCamera(engine,'robot',null,{yaw:0,pitch:0,zoom:1});
      const session=renderedWorld&&(!method||method===renderedWorld.method)?renderedWorld:null;
      const frame=style!==undefined?await eden.requestWorld(engine,camera,{method,style,styleSeed}):
        session?await eden.requestWorld(engine,camera,session):
          await eden.requestPhoto(engine,camera,method,renderedStream??=crypto.randomUUID());
      requireExternal();
      if (worldRevision!==revision||engine.ticks!==tick) throw new Error('渲染期间仿真状态已改变');
      renderedLease={id:frame.key,tick,revision,method:frame.method};
      renderedWorld=frame.sessionId?{method:frame.method,sessionId:frame.sessionId,
        referenceSha256:frame.referenceSha256}:null;
      return { observationId:frame.key,simTick:tick,camera,method:frame.method,renderMs:frame.renderMs,
        image:frame.image,observation:policyObservation(),...(renderedWorld??{}) };
    } finally {
      renderedPending=false;
    }
  }
  window.CityNav=Object.freeze({
    catalog,
    reset:(next={}) => reset(next,'external'),
    step:(action,ticks=1) => {
      requireExternal();
      return step(action,ticks);
    },
    snapshot:() => engine.snapshot(),
    trajectory:() => engine.trajectory(),
    observe:({frames=false}={}) => {
      return engine.observe(engine.sensors,frames ? renderSensorFrame : undefined);
    },
    rendered:Object.freeze({
      start:renderedObservation,
      observe:renderedObservation,
      async openLive({method,style,styleSeed}={}) {
        requireExternal();
        if (!eden) throw new Error('当前入口没有写实渲染端点');
        if (renderedPending) throw new Error('已经在等待写实观测');
        const camera=renderer.displayCamera(engine,'robot',null,{yaw:0,pitch:0,zoom:1});
        renderedPending=true;
        try {
          return await eden.openLive(engine,camera,{method,style,styleSeed},()=>policyObservation());
        } finally {
          renderedPending=false;
        }
      },
      async step(action,{observationId,ticks=2}={}) {
        requireExternal();
        if (!observationId||observationId!==renderedLease?.id||renderedLease.tick!==engine.ticks||
            renderedLease.revision!==worldRevision) throw new Error('写实观测已失效');
        const {method}=renderedLease;
        engine.advanceSteps(action,ticks);
        renderedLease=null;
        dirty=true;
        return renderedObservation({method});
      },
    }),
    policy:Object.freeze({
      reset(next={},options={}) {
        reset(next,'external');
        return policyObservation(options);
      },
      observe:policyObservation,
      step(action,ticks=1,options={}) {
        requireExternal();
        engine.advanceSteps(action,ticks);
        dirty=true;
        return policyObservation(options);
      },
    }),
  });

  refreshTask();
  setMode('ready');
  if (scan||source&&query.get('view')==='robot') setView('robot');
  $('scene-loading').hidden=true;

  function frame(now) {
    const elapsed=Math.min(.25,(now-(last||now))/1000);
    last=now;
    if (mode==='running') {
      let ticks;
      if (eden?.clocked) {
        accumulator=0;
        ticks=eden.readyAt(engine.ticks)?2:0;
      } else {
        frameKeys.clear();
        accumulator+=elapsed;
        ticks=0;
        while (accumulator>=STEP_SECONDS) { accumulator-=STEP_SECONDS; ticks++; }
      }
      if (ticks) {
        step(actionFromInput(),ticks);
        frameKeys.clear();
      }
      if (engine.status!=='running') conclude();
    }
    if (dirty||eden) {
      const sensor=selectedSensor();
      const cameraSensor=sensor && ['rgb','depth'].includes(sensor.type)?sensor:null;
      if (eden) eden.render(engine,cameraSensor,cameraControls.state(),now,dirty,appliedRevision);
      else renderer.render(engine,view,cameraSensor,cameraControls.state());
    }
    if (dirty || now-lastHud>=250) updateHud(now);
    if (!renderer.capturing && !$('sensor-panel').hidden &&
        (lastSensor<0 || (mode==='running'||mode==='external')&&now-lastSensor>=200)) drawSensors(now);
    dirty=false;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

boot().catch(error => {
  console.error(error);
  $('scene-loading').hidden=true;
  $('app-error').textContent='启动失败：'+error.message+'。请使用支持 WebGL 的浏览器。';
  $('app-error').hidden=false;
});
