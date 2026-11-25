export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const lerp = (a, b, t) => a + (b - a) * t;
export const radians = degrees => degrees * Math.PI / 180;
export const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
export const heading = ([x, z], [nextX, nextZ]) => Math.atan2(nextX - x, z - nextZ);
export const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const forward = yaw => [Math.sin(yaw), -Math.cos(yaw)];
export const contains = (box, x, z) => x >= box.x1 && x <= box.x2 && z >= box.z1 && z <= box.z2;
export const intersects = (box, x, z, radius) =>
  Math.hypot(x - clamp(x, box.x1, box.x2), z - clamp(z, box.z1, box.z2)) < radius;

export function randomSource(seed) {
  let state = Number(seed) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
