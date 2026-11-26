// CityEngine owns all transforms and simulation time sent to a renderer.
export function visualWeather(domain) {
  return domain.weather?.snow?'snow':domain.night?'night':domain.weather?.rain?'rain':
    domain.weather?'fog':domain.wet?'wet':'day';
}

export function visualState(engine,camera) {
  const {world}=engine;
  return {
    scene:world.episode?.sceneId,
    episodeId:world.episode?.id,
    robotId:engine.robotId,
    seed:engine.seed,
    weather:visualWeather(engine.domain),
    tick:engine.ticks,
    camera,
    actors:engine.actors.map(({id,kind,color,x,y,z,yaw,speed,progress})=>({
      id,mesh:kind+':'+color,x,y,z,yaw,
      ...(kind==='pedestrian'?{stride:speed?Math.round(Math.sin(engine.time*9+progress)*2):0}:{}),
    })),
    signals:Object.fromEntries(world.crossings.filter(c=>!['stop','yield'].includes(c.mode))
      .map(c=>[c.id,world.crossingSignal(engine.time,c).state==='walk'])),
  };
}
