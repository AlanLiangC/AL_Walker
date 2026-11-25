// A luma tag travels in a 16px transport margin, outside the camera image.
export const margin=16;
const cell=8;
const tagWidth=40*cell;
const magic=0xa7;

function checksum(bytes) {
  let crc=0;
  for (const byte of bytes) {
    crc^=byte;
    for (let i=0;i<8;i++) crc=((crc<<1)^((crc&128)?7:0))&255;
  }
  return crc;
}

function paintTag(context,y,id) {
  const bytes=[magic,id>>>16,(id>>>8)&255,id&255];
  bytes.push(checksum(bytes));
  for (const [index,byte] of bytes.entries()) {
    for (let bit=0;bit<8;bit++) {
      context.fillStyle=byte&(128>>bit)?'#ebebeb':'#101010';
      context.fillRect((index*8+bit)*cell,y,cell,margin);
    }
  }
}

export function makeTagReader() {
  const canvas=document.createElement('canvas');
  canvas.height=9;
  const context=canvas.getContext('2d',{ willReadFrequently:true });
  return (video,y,width) => {
    const copies=Math.floor(width/tagWidth);
    const row=copies*tagWidth;
    if (canvas.width!==row) canvas.width=row;
    context.drawImage(video,0,y+4,row,9,0,0,row,9);
    const pixels=context.getImageData(0,0,row,9).data;
    const found=new Map();
    for (let copy=0;copy<copies;copy++) {
      const bytes=[0,0,0,0,0];
      for (let bit=0;bit<40;bit++) {
        const x=copy*tagWidth+bit*cell+cell/2;
        const mean=(pixels[x*4]+pixels[(4*row+x-2)*4]+pixels[(4*row+x+2)*4]+pixels[(8*row+x)*4])/4;
        bytes[bit>>3]=(bytes[bit>>3]<<1)|(Number(mean>=128)^(copy&1));
      }
      if (bytes[0]!==magic||bytes[4]!==checksum(bytes.slice(0,4))) continue;
      const frameId=(bytes[1]<<16)|(bytes[2]<<8)|bytes[3];
      found.set(frameId,(found.get(frameId)??0)+1);
    }
    const [first,second]=[...found.entries()].sort((a,b)=>b[1]-a[1]);
    return first&&(!second||first[1]>second[1])?first[0]:null;
  };
}

export function createCapture({ width,height,fps }) {
  const canvas=document.createElement('canvas');
  canvas.width=width;
  canvas.height=height+margin;
  const context=canvas.getContext('2d',{ alpha:false });
  // requestFrame admits only frames that have matching metadata.
  const [track]=canvas.captureStream(0).getVideoTracks();
  if (!track.requestFrame) {
    track.stop();
    throw Error('浏览器不支持按需画布采集');
  }
  track.contentHint='motion';
  let next=-Infinity;
  const period=1000/fps;
  return {
    width,height,track,
    due:now=>now>=next-2,
    send(image,frameId,now) {
      context.drawImage(image,0,0,width,height);
      context.fillStyle='#101010';
      context.fillRect(0,height,width,margin);
      paintTag(context,height,frameId);
      track.requestFrame();
      next=now-next>2*period?now+period:next+period;
    },
    stop:()=>track.stop(),
  };
}
