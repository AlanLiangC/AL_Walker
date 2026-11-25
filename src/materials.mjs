export const material = Object.freeze({
  plain:0, asphalt:1, paving:2, grass:3, brick:4, bark:5, concrete:6,
  roadPaint:7, glass:8, enamel:9, metal:10, leaves:11, water:12, sign:13, emitter:14, streetlamp:15,
});

const filenames=['surfaces.webp','surface-relief.webp','leaves.webp','sky.jpg'];

export async function loadCityTextures() {
  const inline=document.getElementById('city-textures');
  const assets=inline ? JSON.parse(inline.textContent) : null;
  const images=await Promise.all(filenames.map(name => {
    const image=new Image();
    image.src=assets?.[name] ?? new URL('../assets/'+name,import.meta.url).href;
    return image.decode().then(() => image);
  }));
  return [...images,signAtlas()];
}

export const signTiles={ 'CITY LIBRARY':0,'QINGSHI MARKET':1,'COMMUNITY CLINIC':2,stop:3,park:4,coffee:5,works:6 };

function signAtlas() {
  const canvas=document.createElement('canvas');
  canvas.width=1024;
  canvas.height=512;
  const ctx=canvas.getContext('2d');
  ctx.textBaseline='middle';
  for (const [index,design] of [
    ['#16323b','#efe1c0','RIVERLINE','CITY LIBRARY'],
    ['#663c2b','#fff0d3','QINGSHI','NEIGHBORHOOD MARKET'],
    ['#344d48','#e8f3ed','COMMUNITY','WALK-IN CLINIC'],
    ['#143247','#ecf0ea','12   CITY LOOP','RIVER PARK STOP'],
    ['#245040','#fff9e7','RIVER PARK','WEST ENTRANCE'],
    ['#644436','#f7e5cb','BANKSIDE','COFFEE & BAKERY'],
    ['#efbd55','#383026','SIDEWALK CLOSED','USE SOUTH WALKWAY'],
  ].entries()) {
    const [bg,fg,title,sub]=design;
    const x=(index%4)*256, y=Math.floor(index/4)*256;
    ctx.fillStyle=bg;
    ctx.fillRect(x,y,256,256);
    ctx.strokeStyle=fg;
    ctx.lineWidth=2;
    ctx.strokeRect(x+12,y+18,232,220);
    ctx.textAlign='center';
    ctx.fillStyle=fg;
    ctx.font='bold 28px system-ui, sans-serif';
    ctx.fillText(title,x+128,y+107,209);
    ctx.font='600 15px system-ui, sans-serif';
    ctx.fillText(sub,x+128,y+149,208);
  }
  return canvas;
}

export function tileUV(index) {
  const x=(index%4)/4, y=Math.floor(index/4)/2;
  return [[x+.002,y+.005],[x+.248,y+.005],[x+.248,y+.495],[x+.002,y+.495]];
}

export function uploadTexture(gl,image,{ repeatX=false,mipmaps=true }={}) {
  const texture=gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D,texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL,gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,image);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,repeatX ? gl.REPEAT : gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  if (mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
  const anisotropy=gl.getExtension('EXT_texture_filter_anisotropic');
  if (mipmaps && anisotropy) {
    const supported=gl.getParameter(anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
    gl.texParameterf(gl.TEXTURE_2D,anisotropy.TEXTURE_MAX_ANISOTROPY_EXT,Math.min(8,supported));
  }
  return texture;
}
