import { bounds, roads, sidewalks, surfaceAt } from './city.mjs';
import { clamp, contains, forward, randomSource } from './math.mjs';

export const domainProfiles = {
  ideal:{ name:'理想基线', description:'保留原版操控与无噪声观测，用于快速排查路线和规则。' },
  outdoor:{ name:'晴天户外', description:'变化的日照与交通节奏、控制延迟，以及异步有噪声的传感器。' },
  wet:{ name:'湿滑低能见度', description:'雨后路面、较远的制动距离、低对比度和更多深度及雷达丢失。' },
  night:{ name:'城市雨夜', description:'街灯、机器人前灯和低照度雨幕。湿路会映出街道与车灯。' },
  storm:{ name:'暴雨强侧风', description:'雨帘遮挡远处路口。侧风扰动、制动距离和测距丢失随降雨增强。' },
  blizzard:{ name:'暴雪结冰', description:'积雪遮挡路面，冰面降低牵引力。控制响应和制动明显变慢。' },
  fog:{ name:'极浓雾', description:'低对比度和极短视距。LiDAR 与深度观测会在更近距离丢失。' },
  'storm-night':{ name:'暴雨夜间', description:'强降水、湿路反光和短视距叠加，前灯只能照亮近处。' },
};

const extremeWeather={
  storm:{ visibility:12,scatter:.65,rain:2.25,grip:.77,wind:.16,lag:100,pace:.92 },
  blizzard:{ visibility:8.7,scatter:.76,rain:2.70,snow:true,grip:.49,wind:.13,lag:150,pace:.82 },
  fog:{ visibility:7.3,scatter:.73,rain:0,grip:1,wind:0,lag:0,pace:.98 },
  'storm-night':{ visibility:9.5,scatter:.74,rain:2.55,grip:.72,wind:.18,lag:100,pace:.86 },
};

export const SENSOR_LATENCY_MAX_MS = 1000;
export const SENSOR_RATE_MIN_HZ = 1;
export const SENSOR_RATE_MAX_HZ = 20;

export function sensorDefaults(type,domain) {
  if (!domain.field) return { rateHz:SENSOR_RATE_MAX_HZ,latencyMs:0,noise:0,dropout:0 };
  const [rateHz,latencyMs,noise,dropout] = {
    rgb:[10,100,2.8,0], depth:[10,150,.014,.035], lidar:[10,100,.026,.025],
    imu:[20,50,.045,0], gps:[5,250,.25,.025],
  }[type];
  const wetDropout = { rgb:0, depth:.14, lidar:.10, imu:0, gps:.035 }[type];
  const scatter=domain.weather?.scatter??0;
  const weatherDelay=['rgb','depth','lidar'].includes(type)?Math.round(scatter*2)*50:0;
  return { rateHz,latencyMs:latencyMs+weatherDelay,noise:noise*domain.sensorGain,
    dropout:dropout+domain.wet*wetDropout,scatter,visibility:domain.weather?.visibility };
}

export function keyedRandom(seed,key,tick=0) {
  let hash=(2166136261 ^ seed) >>> 0;
  for (let i=0;i<key.length;i++) hash=Math.imul(hash^key.charCodeAt(i),16777619);
  hash=Math.imul(hash^tick,0x45d9f3b);
  return randomSource(hash^(hash>>>16));
}

export function gaussian(random) {
  return Math.sqrt(-2*Math.log(1-random()))*Math.cos(2*Math.PI*random());
}

export function createDomain(id,seed) {
  if (!Object.hasOwn(domainProfiles,id)) throw new RangeError('未知仿真环境 ' + id);
  if (id==='ideal') {
    return { id,field:false,wet:0,sensorGain:0,delayMs:0,speedGain:1,turnGain:1,
      acceleration:4.8,braking:9,turnAcceleration:Infinity,yawBias:0,
      exposure:1,fogDistance:106,sky:[.73,.82,.83],haze:[.72,.82,.81],warmth:0 };
  }
  const random=keyedRandom(seed,'episode');
  const moisture=.68+.27*random();
  const night=id==='night'||id==='storm-night';
  const weather=extremeWeather[id];
  const wet=id==='wet'||night||id==='storm' ? moisture : 0;
  const profile={
    id,field:true,wet,night,sensorGain:.86+random()*.31+wet*.42+(night?.27:0),
    delayMs:(2+Math.floor(random()*2))*50,
    speedGain:.88+random()*.18,
    turnGain:.88+random()*.18,
    acceleration:2.45+.95*random(),
    braking:4.7+1.1*random(),
    turnAcceleration:4.5+2.5*random(),
    yawBias:(random()-.5)*.055,
    exposure:.87+random()*.22-wet*.14,
    fogDistance:wet ? (night?39:31)+18*random() : 85+47*random(),
    sky:wet ? [.53,.60,.64] : [.65,.79,.87],
    haze:wet ? [.59,.65,.68] : [.77,.83,.83],
    warmth:wet ? -.20 : -.08+.38*random(),
  };
  if (!weather) return profile;
  return { ...profile,weather,delayMs:profile.delayMs+weather.lag,
    speedGain:profile.speedGain*weather.pace,turnGain:profile.turnGain*(weather.snow?.82:1),
    sensorGain:profile.sensorGain+.55, windPhase:random()*Math.PI*2,
    haze:weather.snow?[.81,.86,.90]:night?[.195,.235,.30]:[.67,.73,.77] };
}

function pavedStreet(x,z) {
  return roads.some(area => contains(area,x,z)) || sidewalks.some(area => contains(area,x,z));
}

export function updateDrive(player,robot,domain,command,dt,pavedAt=pavedStreet,time=0) {
  const { throttle,turn,brake }=command;
  let traction=1;
  if (domain.field) {
    const { x,z }=player;
    traction=pavedAt(x,z) ? 1-domain.wet*.4 : .90-domain.wet*.34;
  }
  if (domain.weather) traction*=domain.weather.grip;
  const target=brake ? 0 : throttle*(throttle<0 ? robot.reverse : robot.speed)*domain.speedGain;
  const limit=(brake ? domain.braking : domain.acceleration)*traction*dt;
  const speed=player.speed+clamp(target-player.speed,-limit,limit);
  const desiredYaw=turn*robot.turn*domain.turnGain+speed*domain.yawBias;
  const turnLimit=domain.turnAcceleration*traction*dt;
  const yawRate=player.yawRate+clamp(desiredYaw-player.yawRate,-turnLimit,turnLimit);
  const sideSpeed=domain.weather
    ? Math.min(1,Math.abs(speed))*domain.weather.wind*Math.sin(time*1.65+domain.windPhase)
    : 0;
  return { speed,yawRate,sideSpeed };
}

export function rigMotion(player,time,domain,ground=surfaceAt,limits=bounds,gaitScale=1) {
  if (!domain.field) return { pitch:0,bob:0 };
  const [fx,fz]=forward(player.yaw);
  const [x,z]=[player.x,player.z];
  const front=ground(x+fx*.3,z+fz*.3);
  const rear=ground(x-fx*.3,z-fz*.3);
  const delta=front-rear;
  const grade=contains(limits,x,z)&&Math.abs(delta)<.25 ? Math.atan2(delta,.6) : 0;
  const gait=gaitScale*Math.min(1,Math.abs(player.speed))*Math.sin(player.walkPhase ?? time*10);
  return { pitch:grade+.030*gait,bob:.023*gait };
}
