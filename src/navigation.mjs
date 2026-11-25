import { clamp, distance, heading, wrap } from './math.mjs';
import { crossings, crossingSignal } from './city.mjs';

export function makeRoute(points) {
  let total = 0;
  const segments = points.slice(1).map((to, index) => {
    const from = points[index];
    const length = distance(from, to);
    const segment = { from, to, length, start:total, yaw:heading(from, to) };
    total += length;
    return segment;
  });
  return { points, segments, total };
}

export function locate(route, x, z) {
  let best = { offset:Infinity };
  for (const [index, segment] of route.segments.entries()) {
    const [a, b] = segment.from;
    const [c, d] = segment.to;
    const fraction = clamp(((x-a)*(c-a)+(z-b)*(d-b)) / segment.length**2, 0, 1);
    const offset = Math.hypot(x-a-(c-a)*fraction, z-b-(d-b)*fraction);
    if (offset <= best.offset) {
      best = { index, offset, along:segment.start + fraction*segment.length };
    }
  }
  return best;
}

export function guidance(route, player, time, intersections = crossings, signalAt = crossingSignal) {
  const nearest = locate(route, player.x, player.z);
  const active = route.segments[nearest.index];
  const remaining = Math.max(route.total - nearest.along, distance([player.x,player.z], route.points.at(-1)));
  const nextIndex = route.segments.findIndex((segment, index) =>
    index > nearest.index && Math.abs(wrap(segment.yaw-route.segments[index-1].yaw)) > .35);
  const next = route.segments[nextIndex];
  const upcomingCrossing = intersections.map(crossing => {
    const center = [(crossing.x1+crossing.x2)/2, (crossing.z1+crossing.z2)/2];
    const projected = locate(route, ...center);
    return { crossing, distance:projected.along-nearest.along, offset:projected.offset };
  }).filter(item => item.offset < 1.8 && item.distance >= -5 && item.distance <= 28)
    .sort((a,b) => a.distance-b.distance)[0];
  let instruction = '沿路线直行';
  let symbol = '↑';
  let maneuverDistance = next ? Math.max(0, next.start-nearest.along) : remaining;
  if (next && maneuverDistance <= 30) {
    const turn = wrap(next.yaw-route.segments[nextIndex-1].yaw);
    [instruction, symbol] = turn > 0 ? ['前方右转','↱'] : ['前方左转','↰'];
  }
  if (remaining < 5) [instruction, symbol] = ['即将抵达','◎'];
  if (Math.abs(wrap(active.yaw-player.yaw)) > 2.25 && remaining > 5) {
    [instruction, symbol] = ['请调转方向','↶'];
  }
  if (nearest.offset > 6) {
    [instruction, symbol] = ['已偏离路线','↺'];
    maneuverDistance = nearest.offset;
  }
  return {
    ...nearest, remaining, instruction, symbol, maneuverDistance,
    etaSeconds:Math.ceil(remaining / 1.25),
    signal:upcomingCrossing ? {
      id:upcomingCrossing.crossing.id, name:upcomingCrossing.crossing.name,
      speed:upcomingCrossing.crossing.speed,
      distance:Math.max(0,upcomingCrossing.distance),
      ...signalAt(time, upcomingCrossing.crossing),
    } : null,
  };
}
