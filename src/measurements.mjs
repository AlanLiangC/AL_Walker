import { buildings } from './city.mjs';
import { gaussian, keyedRandom, sensorDefaults, rigMotion, SENSOR_LATENCY_MAX_MS, SENSOR_RATE_MIN_HZ } from './domain.mjs';
import { clamp } from './math.mjs';
import { lidarScan, sensorPose, sensorReading } from './sensors.mjs';
import { trafficBox } from './traffic.mjs';

export function sensorTiming(config,domain) {
  const defaults=sensorDefaults(config.type,domain);
  return { ...defaults, rateHz:config.rateHz ?? defaults.rateHz, latencyMs:config.latencyMs ?? defaults.latencyMs };
}

export function captureTick(tick,dt,timing) {
  const latencyTicks=Math.ceil(timing.latencyMs/(dt*1000));
  const past=tick-latencyTicks;
  if (past<0) return -1;
  const samplesPerTick=timing.rateHz*dt;
  const sample=Math.floor(past*samplesPerTick+1e-8);
  return Math.ceil(sample/samplesPerTick-1e-8);
}

function gpsReading(pose,state,random,bias,timing,world) {
  const nearBuilding=world.id==='scan'||(world.layout?.buildings??buildings).some(b => Math.hypot(
    pose.x-clamp(pose.x,b.x1,b.x2),pose.z-clamp(pose.z,b.z1,b.z2)
  )<8);
  if (random()<timing.dropout*(nearBuilding ? 2.8 : 1)) return { fix:false,localPosition:null };
  const drift=nearBuilding ? 1.8 : .55;
  const position=[pose.x,pose.y,pose.z].map((value,index) =>
    value+bias[index]*drift+.24*Math.sin(state.time*.18+bias[index]*2)+gaussian(random)*timing.noise*.7);
  return { fix:true,localPosition:position };
}

function attenuation(distance,timing) {
  if (!timing.scatter) return 0;
  return timing.scatter*(1-Math.exp(-Math.pow(distance/timing.visibility,1.42)));
}

function noisyImage(raw,config,timing,random) {
  if (!timing.noise) return raw;
  const {data,width,height}=raw;
  if (config.type==='depth') {
    for (let index=0;index<data.length;index++) {
      const value=data[index];
      if (!value) continue;
      const relative=value/config.range;
      if (random()<Math.min(.98,timing.dropout*(.3+.95*relative)+attenuation(value,timing))) data[index]=0;
      else data[index]=clamp(value+gaussian(random)*timing.noise*(1+6*relative**2),.001,config.range);
    }
  } else {
    for (let y=0;y<height;y++) for (let x=0;x<width;x++) {
      const index=(y*width+x)*4;
      const vignette=1-.09*((x/width-.5)**2+(y/height-.5)**2)*2;
      const noise=gaussian(random)*timing.noise;
      for (let ch=0;ch<3;ch++) data[index+ch]=clamp(Math.round(data[index+ch]*vignette+noise),0,255);
    }
  }
  return raw;
}

export function readSample(config,state,timing,domain,seed,render,world) {
  const rig=rigMotion(state.player,state.time,domain,world.surfaceAt,world.bounds);
  const pose=sensorPose(state.player,config,rig);
  const base={ id:config.id,type:config.type,pose,available:true,sampleTime:state.time,rateHz:timing.rateHz,latencyMs:timing.latencyMs };
  const random=keyedRandom(seed,config.id,state.tick);
  if (config.type==='lidar') {
    const objects=[...world.colliders,...state.actors.map(trafficBox)];
    const scan=lidarScan(config,pose,objects,world.groundRay);
    if (domain.field) scan.ranges=scan.ranges.map(range => {
      const relative=range/config.range;
      if (range>=config.range || random()<Math.min(.98,timing.dropout*(.4+relative)+attenuation(range,timing)*.78)) return config.range;
      return Number(clamp(range+gaussian(random)*timing.noise*(.7+relative),.02,config.range).toFixed(3));
    });
    return { ...base,...scan };
  }
  if (domain.field && config.type==='gps') {
    const episodeRandom=keyedRandom(seed,'gps-bias:'+config.id);
    const bias=[0,1,2].map(() => (episodeRandom()-.5)*2.5);
    return { ...base,...gpsReading(pose,state,random,bias,timing,world) };
  }
  let inertial;
  if (domain.field && config.type==='imu') {
    const previousRig=rigMotion(state.previousPlayer,state.time-state.dt,domain,world.surfaceAt,world.bounds);
    inertial={
      pitchRate:clamp((rig.pitch-previousRig.pitch)/state.dt,-2,2),
      verticalAcceleration:-rig.bob*(state.player.speed*8)**2,
    };
  }
  const reading=sensorReading(config,state.player,pose,inertial);
  if (domain.field && config.type==='imu') {
    const biasRandom=keyedRandom(seed,'imu-bias:'+config.id);
    reading.angularVelocity=reading.angularVelocity.map(v => v+(biasRandom()-.5)*.035+gaussian(random)*timing.noise*.22);
    reading.specificForce=reading.specificForce.map(v => v+(biasRandom()-.5)*.15+gaussian(random)*timing.noise);
  }
  if (render && ['rgb','depth'].includes(config.type)) {
    reading.frame=noisyImage(render(state,config,pose),config,timing,random);
  }
  return { ...base,...reading };
}

export class SensorTimeline {
  constructor(dt,player,actors,world) {
    this.dt=dt;
    this.world=world;
    this.history=new Array(Math.ceil(SENSOR_WINDOW_SECONDS/dt)+2);
    this.record(0,player,actors);
  }

  record(tick,player,actors) {
    this.tick=tick;
    const previousPlayer=tick>0 ? this.history[(tick-1)%this.history.length].player : player;
    this.history[tick%this.history.length]={ tick,time:tick*this.dt,dt:this.dt,player,previousPlayer,actors };
  }

  sample(config,domain,seed,render) {
    const timing=sensorTiming(config,domain);
    const tick=captureTick(this.tick,this.dt,timing);
    if (tick<0) {
      return { id:config.id,type:config.type,available:false,sampleTime:null,
        rateHz:timing.rateHz,latencyMs:timing.latencyMs };
    }
    const state=this.history[tick%this.history.length];
    return readSample(config,state,timing,domain,seed,render,this.world);
  }
}

// Maximum configured transport latency plus one interval at the minimum capture rate.
const SENSOR_WINDOW_SECONDS=SENSOR_LATENCY_MAX_MS/1000+1/SENSOR_RATE_MIN_HZ;
