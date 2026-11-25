import { clamp, wrap } from './math.mjs';

const neutral=()=>({ yaw:0,pitch:0,zoom:1 });

export function bindViewControls(canvas,onChange) {
  const offsets=new Map();
  const pointers=new Map();
  let mode='chase';
  const state=()=>offsets.get(mode)??neutral();

  function update(changes) {
    const next={ ...state(),...changes };
    offsets.set(mode,next);
    onChange(next);
  }

  function zoom(ratio) {
    const minimum=mode==='robot'?.62:.44, maximum=mode==='robot'?1.42:3.2;
    update({ zoom:clamp(state().zoom*ratio,minimum,maximum) });
  }

  function start(event) {
    if (event.pointerType==='mouse'&&event.button!==0) return;
    canvas.setPointerCapture(event.pointerId);
    pointers.set(event.pointerId,[event.clientX,event.clientY]);
    canvas.classList.add('dragging');
  }
  function move(event) {
    const previous=pointers.get(event.pointerId);
    if (!previous) return;
    const next=[event.clientX,event.clientY];
    const other=[...pointers.entries()].find(([id])=>id!==event.pointerId)?.[1];
    pointers.set(event.pointerId,next);
    if (other) {
      const oldGap=Math.hypot(previous[0]-other[0],previous[1]-other[1]);
      const newGap=Math.hypot(next[0]-other[0],next[1]-other[1]);
      if (oldGap>8&&newGap>8) zoom(oldGap/newGap);
      return;
    }
    const {yaw,pitch}=state();
    update({
      yaw:wrap(yaw+(next[0]-previous[0])*.006),
      pitch:clamp(pitch+(next[1]-previous[1])*.0055,-1.5,1.5),
    });
  }
  function end(event) {
    pointers.delete(event.pointerId);
    if (!pointers.size) canvas.classList.remove('dragging');
  }
  function reset() {
    offsets.delete(mode);
    onChange(state());
  }

  canvas.addEventListener('pointerdown',start);
  canvas.addEventListener('pointermove',move);
  for (const type of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(type,end);
  canvas.addEventListener('wheel',event=>{
    event.preventDefault();
    const scale=event.deltaMode===1?16:event.deltaMode===2?72:1;
    zoom(Math.exp(event.deltaY*scale*.0013));
  },{ passive:false });
  canvas.addEventListener('dblclick',reset);
  return {
    state,
    select(value) { mode=value; onChange(state()); },
    reset,
  };
}

export function lookAround(pose,fov,view) {
  return {
    pose:{ ...pose,yaw:pose.yaw+view.yaw,pitch:clamp(pose.pitch+view.pitch,-1.43,1.43) },
    fov:clamp(fov*view.zoom,33,145),
  };
}

export function chaseOrbit(player,view,{ distance=3.55, elevation=.35, height=.56 }={}) {
  const yaw=player.yaw+view.yaw;
  const pitch=clamp(elevation+view.pitch,.06,1.50);
  const range=distance*view.zoom;
  const horizontal=Math.cos(pitch)*range;
  const [x,z]=[Math.sin(yaw),-Math.cos(yaw)];
  const target=[player.x+x*.62,player.y+height,player.z+z*.62];
  return { eye:[player.x-x*horizontal,player.y+height+Math.sin(pitch)*range,player.z-z*horizontal],target };
}

export function overheadOrbit(player,view) {
  const pitch=clamp(1.566-view.pitch,.28,1.566);
  const radius=46*view.zoom;
  const horizontal=Math.cos(pitch)*radius;
  return { eye:[player.x+Math.sin(view.yaw)*horizontal,player.y+Math.sin(pitch)*radius,player.z+Math.cos(view.yaw)*horizontal],
    target:[player.x,player.y,player.z] };
}
