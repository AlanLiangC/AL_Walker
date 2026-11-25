import { clamp, distance, heading, lerp, randomSource } from './math.mjs';
import { crossings, crossingSignal, signalAt, surfaceAt } from './city.mjs';
import { keyedRandom } from './domain.mjs';
import { makeRoute } from './navigation.mjs';

const tracks = [
  { id:'sedan-e', kind:'car', color:'#dfb34b', speed:6.4, road:'eastWest', stop:52, points:[[-72,-3],[72,-3]] },
  { id:'van-w', kind:'van', color:'#d0e0e7', speed:5.4, road:'eastWest', stop:52, points:[[72,3],[-72,3]] },
  { id:'sedan-s', kind:'car', color:'#679cac', speed:6.0, road:'northSouth', stop:43, points:[[-3,-63],[-3,63]] },
  { id:'sedan-n', kind:'car', color:'#bf6b56', speed:6.2, road:'northSouth', stop:43, points:[[3,63],[3,-63]] },
  { id:'cycle-e', kind:'bike', color:'#d29461', speed:3.1, road:'eastWest', stop:53, points:[[-72,6.65],[72,6.65]] },
  { id:'local-van', kind:'car', color:'#79b0a1', speed:2.9, points:[[40,-61],[40,-11.1],[42.4,-11.1],[42.4,-61]], localStop:43 },
  { id:'commuter', kind:'pedestrian', color:'#e39358', speed:1.38, crossing:'west', stop:6, points:[[-12,-12],[-12,12.1]], delay:4 },
  { id:'resident', kind:'pedestrian', color:'#4c8182', speed:1.31, crossing:'south', stop:4.8, points:[[-11,13],[11,13]], delay:3 },
  { id:'shopper', kind:'pedestrian', color:'#aa605e', speed:1.27, points:[[47,-14.3],[34,-14.3],[47,-14.3]], delay:1.2 },
  { id:'park-walker', kind:'pedestrian', color:'#e5b057', speed:1.21, points:[[-56,17.6],[-30,17.6],[-30,40],[-46,40],[-30,40],[-30,17.6],[-56,17.6]] },
  { id:'bus-rider', kind:'pedestrian', color:'#738baa', speed:.88, points:[[-36,9.55],[-24,9.55],[-36,9.55]] },
  { id:'plaza-walker', kind:'pedestrian', color:'#766f9b', speed:1.24, points:[[54.8,33],[54.8,41],[48.9,41],[48.9,36],[54.8,33]] },
].map(track => ({ ...track, path:makeRoute(track.points) }));

export function createTraffic(seed,domain) {
  const random = randomSource(seed);
  return tracks.map(track => {
    const progress=track.delay != null ? -track.delay-random()*3 : random()*8;
    const actor=makeActor(track,progress);
    if (!domain?.field) return actor;
    const variation=keyedRandom(seed,'traffic:'+track.id);
    return { ...actor,speedFactor:(.80+variation()*.40)*(1-domain.wet*(track.kind==='pedestrian'?.08:.15)),
      reactionDistance:1.4+variation()*.9 };
  });
}

function makeActor(track, progress) {
  const segment = track.path.segments.find(item => progress <= item.start+item.length) ?? track.path.segments.at(-1);
  const fraction = clamp((progress-segment.start)/segment.length, 0, 1);
  const x = lerp(segment.from[0],segment.to[0],fraction);
  const z = lerp(segment.from[1],segment.to[1],fraction);
  return { id:track.id, kind:track.kind, color:track.color, x, z, y:surfaceAt(x,z),
    yaw:heading(segment.from,segment.to), speed:0, progress };
}

export function advanceTraffic(actors, player, time, dt, domain) {
  return actors.map((actor,index) => {
    const track = tracks[index];
    let speed=track.speed*(actor.speedFactor ?? 1);
    if (domain?.field && track.kind==='pedestrian') {
      const [dx,dz]=[player.x-actor.x,player.z-actor.z];
      const sine=Math.sin(actor.yaw),cosine=Math.cos(actor.yaw);
      const ahead=dx*sine-dz*cosine;
      const lateral=Math.abs(dx*cosine+dz*sine);
      // A pedestrian slows for an approaching robot in the same part of the path.
      if (ahead>0 && ahead<actor.reactionDistance && lateral<.73) {
        speed*=clamp((ahead-.74)/(actor.reactionDistance-.74),0,1);
      }
    }
    let next = actor.progress + speed*dt;
    if (track.stop != null && actor.progress <= track.stop + 1e-6) {
      const state = track.crossing
        ? crossingSignal(time,crossings.find(crossing => crossing.id === track.crossing)).state
        : signalAt(time,track.road).state;
      if (state !== 'green' && state !== 'walk') next = Math.min(next,track.stop);
    }
    if (track.localStop && actor.progress <= track.localStop + 1e-6) {
      const passing = [player,...actors.filter(other => other.kind === 'pedestrian')]
        .some(other => distance([other.x,other.z],[41,-13.25]) < 5);
      if (passing) next = Math.min(next,track.localStop);
    }
    if (next > track.path.total) next = track.crossing ? -track.delay*track.speed : next-track.path.total;
    const moved = makeActor(track,next);
    moved.speed = next > actor.progress && next > 0 ? (next-actor.progress)/dt : 0;
    if (domain?.field) {
      moved.speedFactor=actor.speedFactor;
      moved.reactionDistance=actor.reactionDistance;
    }
    return moved;
  });
}

export function trafficBox(actor) {
  const [width, length, height] = ({
    car:[1.85,4.05,1.55], van:[2.05,4.7,2.28], bike:[.68,1.85,1.75], pedestrian:[.52,.5,1.78],
  })[actor.kind];
  const sine = Math.abs(Math.sin(actor.yaw));
  const cosine = Math.abs(Math.cos(actor.yaw));
  const halfX = (width*cosine+length*sine)/2;
  const halfZ = (width*sine+length*cosine)/2;
  return { id:actor.id, kind:actor.kind, x1:actor.x-halfX, x2:actor.x+halfX,
    z1:actor.z-halfZ, z2:actor.z+halfZ, y:actor.y, height };
}
