// Cityscapes labelIds, written losslessly before the image lighting pass.
export const layoutClass = Object.freeze({
  road:7, sidewalk:8, building:11, wall:12, fence:13, pole:17, signal:19,
  sign:20, vegetation:21, terrain:22, sky:23, person:24, car:26, truck:27, bicycle:33,
});

export const actorClass = Object.freeze({
  car:layoutClass.car, van:layoutClass.truck, bike:layoutClass.bicycle, pedestrian:layoutClass.person,
});

// Meshes retain their original 12 floats per vertex and separate visual material from class.
export const materialStride=64;

export function semanticControl(renderer,engine,camera,options) {
  const {width,height}=options;
  const pixels=renderer.semanticGeometry(engine,camera,options);
  const target=document.createElement('canvas');
  target.width=width;
  target.height=height;
  const rgba=new Uint8ClampedArray(pixels.length);
  const stride=width*4;
  for (let row=0;row<height;row++) rgba.set(pixels.subarray(row*stride,(row+1)*stride),(height-1-row)*stride);
  target.getContext('2d').putImageData(new ImageData(rgba,width,height),0,0);
  return target.toDataURL('image/png').split(',')[1];
}
