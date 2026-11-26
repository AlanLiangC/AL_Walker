import { domainProfiles, SENSOR_LATENCY_MAX_MS, SENSOR_RATE_MAX_HZ, SENSOR_RATE_MIN_HZ } from './domain.mjs';
import { defaultSensor, robots, sensorTypes } from './sensors.mjs';
import { challengeCatalog, episodeCatalog, findEpisode, sceneCatalog, sceneFamilies, scenarios } from './scene-families.mjs';
import { describeUrbanEpisode } from './urban-episode.mjs';
import { getUrbanScene } from './urban-scene.mjs';

const $ = id => document.getElementById(id);

export function option(value,label) {
  const item=new Option(label,value);
  return item;
}

const fields = {
  forward:['前后（m）',-2,2], right:['左右（m）',-2,2], height:['离地高度（m）',.04,3],
  yaw:['偏航（°）',-180,180], pitch:['俯仰（°）',-80,80],
  fov:['水平视场（°）',20,145], range:['量程（m）',1,100], rays:['射线数',8,361],
  rateHz:['采样率（Hz）',SENSOR_RATE_MIN_HZ,SENSOR_RATE_MAX_HZ], latencyMs:['延迟（ms）',0,SENSOR_LATENCY_MAX_MS],
};

export function setupEditor(onSubmit,world) {
  const {tasks}=world;
  const supportsBenchmark=world.id!=='scan';
  const sceneSelect=$('scene-select');
  const episodesByScene=new Map(sceneCatalog.map(scene=>[scene.id,[]]));
  for (const episode of episodeCatalog) episodesByScene.get(episode.sceneId).push(episode);
  const taskSelect=$('task-select'),robotSelect=$('robot-select'),settings=$('sensor-settings');
  const domainSelect=$('domain-select');
  function updateTaskOptions() {
    if (sceneSelect.value==='extreme') {
      const groups=new Map();
      for (const item of challengeCatalog) {
        if (!groups.has(item.scenario)) {
          const group=document.createElement('optgroup');
          group.label=item.name;
          groups.set(item.scenario,group);
        }
        groups.get(item.scenario).append(option(item.id,item.sceneName));
      }
      taskSelect.replaceChildren(...groups.values());
      return;
    }
    const items=episodesByScene.get(sceneSelect.value);
    taskSelect.replaceChildren(...(items
      ? items.map(item=>option(item.id,item.id.split('-').at(-1).toUpperCase()+' · '+item.name))
      : tasks.map(task=>option(task.id,task.name+' · '+task.limit+' 秒'))));
  }
  if (supportsBenchmark) {
    const groups=sceneFamilies.map(family=>{
      const group=document.createElement('optgroup');
      group.label=family.name;
      group.append(...sceneCatalog.filter(scene=>scene.family===family.id)
        .map(scene=>option(scene.id,scene.name+' · '+({train:'训练',validation:'验证',test:'测试'})[scene.split])));
      return group;
    });
    sceneSelect.replaceChildren(option('', '经典城区 · 4 条原始路线'),
      option('extreme','极限挑战 · '+challengeCatalog.length+' 条'),...groups);
    $('benchmark-picker').hidden=false;
    $('benchmark-count').textContent=sceneCatalog.length+' 个场景 · '+episodeCatalog.length.toLocaleString()+' 条标准 · '+challengeCatalog.length+' 条极限';
  }
  updateTaskOptions();
  robotSelect.replaceChildren(...Object.entries(robots).map(([id,robot]) => option(id,robot.name+' · '+robot.family)));
  domainSelect.replaceChildren(...(world.profiles ?? Object.keys(domainProfiles)).map(id => option(id,domainProfiles[id].name)));
  let sensors=[];
  let previousRobot='go2';
  let nextId=1;

  function summaries() {
    const episode=findEpisode(taskSelect.value);
    const task=tasks.find(item => item.id===taskSelect.value);
    const robot=robots[robotSelect.value];
    if (episode?.difficulty==='extreme') {
      const { length,maxSeconds,crossings,population }=describeUrbanEpisode(episode.id);
      const traffic=[population.pedestrians+' 名行人',population.vehicles+' 辆机动车',population.cyclists+' 辆自行车'];
      if (population.pedestrianStreams) traffic.push(population.pedestrianStreams+' 处人流交汇');
      $('task-detail').textContent=episode.name+' · '+Math.round(length)+' m · '+maxSeconds+' 秒';
      $('task-conditions').textContent=[...traffic,...new Set(crossings.map(c=>c.name))].join(' · ');
    } else if (episode) {
      const layout=getUrbanScene(episode.sceneId);
      const route=layout.routes[episode.routeIndex];
      const scenario=scenarios.find(item=>item.id===episode.scenario);
      $('task-detail').textContent=Math.round(route.length)+' m · 路点 '+(route.start+1)+' 至 '+(route.goal+1)+' · '+scenario.name;
      $('task-conditions').textContent=[...new Set(route.crossings.map(id=>layout.crossings.find(c=>c.id===id).name))].join(' · ')||'无机动车道穿越';
    } else {
      $('task-detail').textContent=task.description;
      $('task-conditions').textContent=task.conditions;
    }
    $('robot-detail').textContent=robot.family+' · 机身高 '+robot.height.toFixed(2)+' m · 最高 '+robot.speed.toFixed(2)+' m/s';
    $('domain-detail').textContent=domainProfiles[domainSelect.value].description;
  }

  function drawSettings(openIds=new Set()) {
    settings.replaceChildren();
    for (const [index,config] of sensors.entries()) {
      const wrapper=document.createElement('details');
      wrapper.className='sensor-setting';
      wrapper.open=openIds.has(config.id);
      wrapper.dataset.id=config.id;
      const title=document.createElement('summary');
      title.textContent=sensorTypes[config.type]+' · '+config.height.toFixed(2)+' m';
      const row=document.createElement('div');
      row.className='sensor-row';
      const type=document.createElement('label');
      type.textContent='类型';
      const select=document.createElement('select');
      select.replaceChildren(...Object.entries(sensorTypes).map(([id,name]) => option(id,name)));
      select.value=config.type;
      select.addEventListener('change',() => {
        const { forward,right,height,yaw,pitch,rateHz,latencyMs }=config;
        sensors[index]={ ...defaultSensor(select.value,robotSelect.value,config.id),forward,right,height,yaw,pitch,rateHz,latencyMs };
        drawSettings(expanded());
      });
      type.append(select);
      row.append(type);
      const keys=['forward','right','height','yaw','pitch'];
      if (['rgb','depth','lidar'].includes(config.type)) keys.push('fov','range');
      if (config.type==='lidar') keys.push('rays');
      keys.push('rateHz','latencyMs');
      for (const key of keys) {
        const [display,min,max]=key==='fov'&&config.type==='lidar' ? ['水平视场（°）',5,360] : fields[key];
        const label=document.createElement('label');
        label.textContent=display;
        const input=document.createElement('input');
        const optional=key==='rateHz'||key==='latencyMs';
        Object.assign(input,{ type:'number',min,max,step:key==='rays'?'1':'any',
          value:config[key] == null ? '' : Number(config[key].toFixed(4)),required:!optional });
        if (optional) input.placeholder='按环境预设';
        input.addEventListener('input',() => {
          if (optional && input.value==='') delete config[key];
          else config[key]=input.valueAsNumber;
          if (key==='height' && Number.isFinite(config[key])) title.textContent=sensorTypes[config.type]+' · '+config.height.toFixed(2)+' m';
        });
        label.append(input);
        row.append(label);
      }
      const remove=document.createElement('button');
      Object.assign(remove,{ type:'button',className:'button quiet sensor-remove',textContent:'移除' });
      remove.addEventListener('click',() => {
        const open=expanded();
        sensors.splice(index,1);
        drawSettings(open);
      });
      row.append(remove);
      wrapper.append(title,row);
      settings.append(wrapper);
    }
    if (!sensors.length) settings.textContent='未安装传感器';
    $('add-sensor').disabled=sensors.length>=8;
  }

  const expanded=() => new Set([...settings.querySelectorAll('details[open]')].map(item => item.dataset.id));
  function chooseTask() {
    const episode=findEpisode(taskSelect.value);
    $('seed').value=(episode??tasks.find(item=>item.id===taskSelect.value)).seed;
    domainSelect.value=episode?.domain??'ideal';
    summaries();
  }
  taskSelect.addEventListener('change',chooseTask);
  sceneSelect.addEventListener('change',()=>{
    updateTaskOptions();
    chooseTask();
  });
  domainSelect.addEventListener('change',summaries);
  robotSelect.addEventListener('change',() => {
    sensors=sensors.map(sensor => {
      const before=defaultSensor(sensor.type,previousRobot,sensor.id);
      const after=defaultSensor(sensor.type,robotSelect.value,sensor.id);
      const next={ ...sensor };
      for (const key of ['forward','height']) {
        if (Math.abs(before[key]-sensor[key])<.0001) next[key]=after[key];
      }
      return next;
    });
    previousRobot=robotSelect.value;
    summaries();
    drawSettings(expanded());
  });
  $('add-sensor').addEventListener('click',() => {
    const open=expanded();
    let id;
    do { id='custom-'+nextId++; } while (sensors.some(item => item.id===id));
    sensors.push(defaultSensor('depth',robotSelect.value,id));
    open.add(id);
    drawSettings(open);
  });
  const form=$('setup-form');
  form.addEventListener('invalid',event => {
    const group=event.target.closest('details');
    if (group) group.open=true;
  },true);
  form.addEventListener('submit',event => {
    event.preventDefault();
    try {
      const episodeId=findEpisode(taskSelect.value)?.id;
      onSubmit({ taskId:taskSelect.value,episodeId,robotId:robotSelect.value,seed:$('seed').valueAsNumber,domain:domainSelect.value,
        sensors:sensors.map(sensor => ({ ...sensor })) }, event.submitter?.value==='start');
    } catch (error) {
      $('config-error').textContent=error.message;
    }
  });
  return engine => {
    const episode=engine.world.episode;
    sceneSelect.value=episode?.difficulty==='extreme'?'extreme':episode?.sceneId??'';
    updateTaskOptions();
    taskSelect.value=engine.task.id;
    robotSelect.value=previousRobot=engine.robotId;
    domainSelect.value=engine.domain.id;
    $('seed').value=engine.seed;
    sensors=structuredClone(engine.sensors);
    $('config-error').textContent='';
    summaries();
    drawSettings();
    $('setup').showModal();
    (supportsBenchmark?sceneSelect:taskSelect).focus();
  };
}
