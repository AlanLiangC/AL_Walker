import { ramp, surfaceAt, terrace } from './city.mjs';
import { SENSOR_LATENCY_MAX_MS, SENSOR_RATE_MAX_HZ, SENSOR_RATE_MIN_HZ } from './domain.mjs';
import { clamp, radians } from './math.mjs';

export const robots = {
  go2:{ name:'Go2 参考型', family:'四足机器人', width:.42, length:.8, height:.60, radius:.46, speed:1.85, reverse:.95, turn:2.6, color:'#e7ad49' },
  b2:{ name:'B2 参考型', family:'重载四足', width:.52, length:1.04, height:.78, radius:.6, speed:2.35, reverse:1.12, turn:2.2, color:'#d67d51' },
  g1:{ name:'G1 参考型', family:'人形机器人', width:.48, length:.42, height:1.32, radius:.34, speed:1.65, reverse:.72, turn:2.35, color:'#cddce1' },
};

export const sensorTypes = {
  rgb:'RGB 相机', depth:'深度相机', lidar:'2D LiDAR', imu:'IMU', gps:'GPS（本地坐标）',
};

export function defaultSensor(type, robotId, id = type) {
  const robot = robots[robotId];
  const imaging = ['rgb','depth','lidar'].includes(type);
  return { id, type, forward:imaging && robotId !== 'g1' ? robot.length*.46 : .08, right:0,
    height:imaging ? robot.height : robot.height*.67, yaw:0, pitch:0,
    fov:type === 'lidar' ? 240 : 86, range:type === 'lidar' ? 26 : 35, rays:91 };
}

export function normalizeSensors(sensors, robotId) {
  if (sensors == null) return ['rgb','lidar','imu','gps'].map(type => defaultSensor(type,robotId));
  if (!Array.isArray(sensors) || sensors.length > 8) throw new RangeError('最多支持 8 个传感器');
  const ids = new Set();
  return sensors.map((item,index) => {
    if (!Object.hasOwn(sensorTypes,item?.type)) throw new RangeError('未知传感器类型');
    const config = defaultSensor(item.type,robotId,String(item.id ?? 'sensor-'+index));
    if (ids.has(config.id)) throw new RangeError('传感器 ID 必须唯一');
    ids.add(config.id);
    const limits = { forward:[-2,2], right:[-2,2], height:[.04,3], yaw:[-180,180],
      pitch:[-80,80], fov:item.type === 'lidar' ? [5,360] : [20,145],
      range:[1,100], rays:[8,361], rateHz:[SENSOR_RATE_MIN_HZ,SENSOR_RATE_MAX_HZ], latencyMs:[0,SENSOR_LATENCY_MAX_MS] };
    for (const [key,[min,max]] of Object.entries(limits)) {
      if (item[key] == null) continue;
      if (!Number.isFinite(item[key])) throw new TypeError('传感器参数必须为有限数值');
      config[key] = clamp(item[key],min,max);
    }
    config.rays = Math.round(config.rays);
    return config;
  });
}

export function sensorPose(player, sensor, rig = { pitch:0,bob:0 }) {
  const sine = Math.sin(player.yaw);
  const cosine = Math.cos(player.yaw);
  const forward=sensor.forward*Math.cos(rig.pitch)-sensor.height*Math.sin(rig.pitch);
  return {
    x:player.x + sine*forward + cosine*sensor.right,
    y:player.y + sensor.height*Math.cos(rig.pitch)+sensor.forward*Math.sin(rig.pitch)+rig.bob,
    z:player.z - cosine*forward + sine*sensor.right,
    yaw:player.yaw + radians(sensor.yaw), pitch:radians(sensor.pitch)+rig.pitch*Math.cos(radians(sensor.yaw)),
  };
}

export function rayDirection(yaw, pitch) {
  return [Math.sin(yaw)*Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw)*Math.cos(pitch)];
}

function rayBox(origin, direction, item, limit) {
  let near = 0;
  let far = limit;
  for (let index=0;index<3;index++) {
    const lower=index===0 ? item.x1 : index===1 ? item.y : item.z1;
    const upper=index===0 ? item.x2 : index===1 ? item.y+item.height : item.z2;
    const delta = direction[index];
    if (Math.abs(delta) < 1e-8) {
      if (origin[index] < lower || origin[index] > upper) return limit;
      continue;
    }
    const a = (lower-origin[index])/delta;
    const b = (upper-origin[index])/delta;
    near = Math.max(near,Math.min(a,b));
    far = Math.min(far,Math.max(a,b));
    if (near > far) return limit;
  }
  return near;
}

function groundHit(origin, direction, range) {
  const bottom=origin[1]+Math.min(0,direction[1])*range;
  if (bottom>.7) return range;
  const elevated={ x1:terrace.x1,x2:terrace.x2,z1:ramp.z1,z2:terrace.z2,y:0,height:.7 };
  if (bottom>.14 && rayBox(origin,direction,elevated,range)===range) return range;
  const heightAbove = t => origin[1]+direction[1]*t - surfaceAt(origin[0]+direction[0]*t, origin[2]+direction[2]*t);
  for (let t=.25; t<=range+.25; t+=.25) {
    const sample = Math.min(t,range);
    if (heightAbove(sample) > 0) continue;
    let near = Math.max(0,sample-.25);
    let far = sample;
    for (let i=0; i<8; i++) {
      const middle = (near+far)/2;
      if (heightAbove(middle) > 0) near = middle;
      else far = middle;
    }
    return far;
  }
  return range;
}

export function geometryRay(origin,direction,range,objects,groundRay=groundHit) {
  let hit=groundRay(origin,direction,range);
  for (const item of objects) hit=Math.min(hit,rayBox(origin,direction,item,hit));
  return hit;
}

export function lidarScan(config, pose, objects, groundRay) {
  const fov = radians(config.fov);
  const angleStep = fov/(config.fov === 360 ? config.rays : config.rays-1);
  const origin = [pose.x,pose.y,pose.z];
  const ranges = Array.from({ length:config.rays }, (_,index) => {
    const angle = -fov/2+angleStep*index;
    const horizontal = Math.cos(angle);
    const vertical = horizontal*Math.sin(pose.pitch);
    const forward = horizontal*Math.cos(pose.pitch);
    const direction = [
      Math.sin(pose.yaw)*forward+Math.cos(pose.yaw)*Math.sin(angle),
      vertical,
      -Math.cos(pose.yaw)*forward+Math.sin(pose.yaw)*Math.sin(angle),
    ];
    const hit=geometryRay(origin,direction,config.range,objects,groundRay);
    return Number(hit.toFixed(3));
  });
  return { ranges, angleMin:-fov/2, angleStep, maxRange:config.range };
}

export function sensorReading(config,player,pose,inertial) {
  switch (config.type) {
    case 'gps': return { fix:true,localPosition:[pose.x,pose.y,pose.z] };
    case 'imu': {
      const sine=Math.sin(radians(config.yaw)),cosine=Math.cos(radians(config.yaw));
      const lateral=inertial ? player.speed*player.yawRate : 0;
      const forward=player.acceleration*cosine+lateral*sine;
      const right=lateral*cosine-player.acceleration*sine;
      const up=9.81+(inertial?.verticalAcceleration ?? 0);
      const cosPitch=Math.cos(pose.pitch), sinPitch=Math.sin(pose.pitch);
      const pitchRate=inertial?.pitchRate ?? 0;
      const angularVelocity=inertial
        ? [pitchRate*cosine,player.yawRate*cosPitch-pitchRate*sine*sinPitch,
          pitchRate*sine*cosPitch+player.yawRate*sinPitch]
        : [0,player.yawRate,0];
      return { angularVelocity,
        specificForce:[right,up*cosPitch-forward*sinPitch,forward*cosPitch+up*sinPitch] };
    }
    default: return { width:256,height:144,horizontalFov:config.fov,maxRange:config.range };
  }
}
