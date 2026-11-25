import { bounds, colliders, crossings, GOAL_RADIUS, surfaceAt, tasks } from './city.mjs';
import { createDomain, updateDrive } from './domain.mjs';
import { clamp, distance, forward, heading, intersects, wrap } from './math.mjs';
import { SensorTimeline } from './measurements.mjs';
import { guidance, makeRoute } from './navigation.mjs';
import { createTraffic, advanceTraffic, trafficBox } from './traffic.mjs';
import { checkRules, OPEN_SPEED, penalties } from './rules.mjs';
import { normalizeSensors, robots } from './sensors.mjs';
import { urbanEpisode } from './urban-episode.mjs';

export const STEP_SECONDS = .05;
export const MIN_SAFETY = 70;
const trajectoryColumns=['time','x','y','z','yaw','speed','yawRate','throttle','turn','brake',
  'appliedThrottle','appliedTurn','appliedBrake'];
const collisionLabels = { tree:'树木', pole:'路灯或信号灯', building:'建筑', water:'水域',
  bench:'长椅', barrier:'施工围挡', cone:'锥桶', planter:'花箱', shelter:'公交站棚',
  container:'施工物料', bin:'垃圾桶', 'parked-car':'停放车辆', bounds:'场景边界', elevation:'台阶高差',
  'alley-wall':'街巷墙面', 'alley-bollard':'石柱', 'alley-bin':'垃圾桶',
  'alley-lamp':'路灯', 'alley-box':'墙边箱体', 'alley-bike':'停放自行车' };
const cityWorld={ id:'city',bounds,colliders,crossings,goalRadius:GOAL_RADIUS,surfaceAt,tasks,
  createTraffic,advanceTraffic,checkRules };

export class CityEngine {
  constructor(config = {},world = cityWorld) {
    this.baseWorld=world;
    this.reset(config);
  }

  reset({ taskId, episodeId, sceneId, robotId = 'go2', sensors, seed, domain, recordTrajectory = false } = {}) {
    if (episodeId!=null&&this.baseWorld!==cityWorld) throw new RangeError('此入口不支持城市 Episode');
    if (seed!=null&&(!Number.isInteger(seed)||seed<0||seed>0xffffffff)) {
      throw new RangeError('随机种子必须为 0 到 4294967295 的整数');
    }
    const world=episodeId!=null ? urbanEpisode(episodeId,seed) : this.baseWorld;
    if (sceneId!=null&&sceneId!==world.episode?.sceneId) throw new RangeError('场景与 Episode 不匹配');
    const id=taskId??world.tasks[0].id;
    const task = world.tasks.find(item => item.id === id);
    if (!task) throw new RangeError('未知任务 ' + taskId);
    if (!Object.hasOwn(robots,robotId)) throw new RangeError('未知机器人 ' + robotId);
    const sensorConfig = normalizeSensors(sensors,robotId);
    const episodeSeed = seed ?? task.seed;
    const domainId=domain??world.episode?.domain??'ideal';
    if (world.profiles && !world.profiles.includes(domainId)) throw new RangeError('此场景不支持该环境');
    const environment=createDomain(domainId,episodeSeed);
    this.world=world;
    this.stopApproach=null;
    this.task = task;
    this.robot = robots[robotId];
    this.robotId = robotId;
    this.route = makeRoute(task.points);
    this.sensors = sensorConfig;
    this.seed = episodeSeed;
    this.domain=environment;
    this.commands=Array.from({ length:Math.round(environment.delayMs/(STEP_SECONDS*1000)) },
      () => ({ throttle:0,turn:0,brake:false }));
    this.actors = this.world.createTraffic(this.seed,environment);
    const [x,z] = task.points[0];
    this.player = { x,z,y:this.world.surfaceAt(x,z), yaw:heading(...task.points.slice(0,2)), speed:0, yawRate:0, acceleration:0 };
    this.sensorTimeline=new SensorTimeline(STEP_SECONDS,this.player,this.actors,this.world);
    this.trajectoryRows=recordTrajectory ? [] : null;
    this.ticks = 0;
    this.time = 0;
    this.traveled = 0;
    this.score = 100;
    this.status = 'running';
    this.reason = null;
    this.events = [];
    this.contacts = new Set();
    this.ruleExposure = {};
    this.context = { speedLimit:this.world.speedLimit ?? OPEN_SPEED, yieldTarget:false, crossing:null };
    return this.snapshot();
  }

  penalize(code, detail, at = this.player) {
    const { label,points,critical } = penalties[code];
    this.score = Math.max(0,this.score-points);
    this.events.push({ code,label,detail:detail ?? null,points,critical,time:this.time,
      position:[at.x,at.y ?? this.world.surfaceAt(at.x,at.z),at.z] });
  }

  advanceSteps(action = {}, ticks = 1) {
    if (!Number.isInteger(ticks) || ticks < 1 || ticks > 2000) throw new RangeError('步数必须为 1–2000 的整数');
    const { throttle = 0, turn = 0, brake = false } = action;
    if (!Number.isFinite(throttle) || !Number.isFinite(turn)) throw new TypeError('控制量必须是有限数值');
    const command={ throttle:clamp(throttle,-1,1),turn:clamp(turn,-1,1),brake:Boolean(brake) };
    for (let tick=0; tick<ticks && this.status === 'running'; tick++) this.advance(command);
  }

  step(action, ticks) {
    this.advanceSteps(action,ticks);
    return this.snapshot();
  }

  advance(input) {
    const dt = STEP_SECONDS;
    const {bounds,colliders,surfaceAt}=this.world;
    this.time = ++this.ticks*dt;
    const previous = this.player;
    this.commands.push(input);
    const command=this.commands.shift();
    const drive=updateDrive(previous,this.robot,this.domain,command,dt,this.world.paved,this.time);
    const { yawRate,sideSpeed }=drive;
    let { speed }=drive;
    const yaw = wrap(previous.yaw+yawRate*dt);
    const [fx,fz] = forward(yaw);
    const next = { x:previous.x+(speed*fx-sideSpeed*fz)*dt, z:previous.z+(speed*fz+sideSpeed*fx)*dt, yaw,speed,yawRate };
    this.actors = this.world.advanceTraffic(this.actors,previous,this.time,dt,this.domain);
    const r = this.robot.radius;
    const contacts = new Set();
    const objects = [...colliders,...this.actors.map(trafficBox)];
    for (const item of objects) {
      if (item.solid === false || contacts.has(item.id) || !intersects(item,next.x,next.z,r)) continue;
      contacts.add(item.id);
      if (this.contacts.has(item.id)) continue;
      const kind = item.kind === 'van' ? 'car' : item.kind;
      const code = ['car','bike','pedestrian'].includes(kind) ? 'collision-'+kind : 'collision-static';
      this.penalize(code,collisionLabels[kind],next);
    }
    const out = next.x-r < bounds.x1 || next.x+r > bounds.x2 || next.z-r < bounds.z1 || next.z+r > bounds.z2;
    if (out) {
      contacts.add('bounds');
      if (!this.contacts.has('bounds')) this.penalize('collision-static',collisionLabels.bounds,next);
    }
    const elevation = surfaceAt(next.x,next.z);
    if (Math.abs(elevation-previous.y) > .32) {
      contacts.add('elevation');
      if (!this.contacts.has('elevation')) this.penalize('collision-static',collisionLabels.elevation,next);
    }
    if (contacts.size) {
      next.x = previous.x;
      next.z = previous.z;
      speed = 0;
    }
    next.y = surfaceAt(next.x,next.z);
    next.speed = speed;
    next.acceleration = (speed-previous.speed)/dt;
    if (this.domain.field) next.walkPhase=(previous.walkPhase ?? 0)+Math.abs(speed)*dt*8;
    for (const item of objects) {
      if (this.contacts.has(item.id) && intersects(item,next.x,next.z,r+.12)) contacts.add(item.id);
    }
    if (this.contacts.has('bounds') && (
      next.x-r-.12 < bounds.x1 || next.x+r+.12 > bounds.x2 || next.z-r-.12 < bounds.z1 || next.z+r+.12 > bounds.z2
    )) contacts.add('bounds');
    this.contacts = contacts;
    this.context = this.world.checkRules(this,next,this.actors,dt);
    this.traveled += distance([previous.x,previous.z],[next.x,next.z]);
    this.player = next;
    this.sensorTimeline.record(this.ticks,this.player,this.actors);
    if (this.trajectoryRows) this.trajectoryRows.push([
      this.time,next.x,next.y,next.z,next.yaw,next.speed,next.yawRate,
      input.throttle,input.turn,Number(input.brake),command.throttle,command.turn,Number(command.brake),
    ]);

    const reached = distance([next.x,next.z],this.task.points.at(-1)) <= this.world.goalRadius;
    if (reached) {
      const safe = this.score >= MIN_SAFETY && !this.events.some(event => event.critical);
      this.status = safe ? 'success' : 'failed';
      this.reason = safe ? 'arrived' : 'unsafe';
    } else if (this.time >= this.task.limit) {
      this.status = 'failed';
      this.reason = 'timeout';
    }
  }

  snapshot() {
    const clone = value => structuredClone(value);
    return {
      taskId:this.task.id, robotId:this.robotId, seed:this.seed, domain:this.domain.id,
      ...(this.world.episode ? {episodeId:this.world.episode.id,sceneId:this.world.episode.sceneId,split:this.world.episode.split}:{}),
      player:clone(this.player), actors:clone(this.actors), sensors:clone(this.sensors),
      time:this.time, remainingTime:Math.max(0,this.task.limit-this.time), traveled:this.traveled,
      score:this.score, status:this.status, reason:this.reason, events:clone(this.events),
      navigation:guidance(this.route,this.player,this.time,this.world.crossings,this.world.crossingSignal), context:{ ...this.context },
    };
  }

  sampleSensors(sensors, render) {
    return sensors.map(config => this.sensorTimeline.sample(config,this.domain,this.seed,render));
  }

  observe(sensors = this.sensors, render) {
    return { time:this.time,player:{ ...this.player },sensors:this.sampleSensors(sensors,render) };
  }

  observePolicy(render) {
    const { id,points }=this.task;
    return {
      time:this.time,status:this.status,mission:{ taskId:id,route:structuredClone(points),
        ...(this.world.episode?{episodeId:this.world.episode.id,sceneId:this.world.episode.sceneId}:{}) },
      sensors:this.sampleSensors(this.sensors,render).map(({ pose,...measurement }) => measurement),
    };
  }

  trajectory() {
    return this.trajectoryRows ? { columns:[...trajectoryColumns], samples:structuredClone(this.trajectoryRows) } : null;
  }
}
