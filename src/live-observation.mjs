import { EdenSession } from './eden-session.mjs';

export class LiveObservation {
  constructor(config,context,reference,observe) {
    this.observe=observe;
    this.canvas=document.createElement('canvas');
    this.surface=this.canvas.getContext('2d',{alpha:false});
    this.waiting=new Set();
    this.closed=false;
    this.client=new EdenSession(config,{
      status:value=>{ if(value!=='live') this.latest=null; },
      present:(video,meta,{width,height})=>{
        if (!['conditioned','reference'].includes(meta.mapping)) return;
        if (this.canvas.width!==width||this.canvas.height!==height) {
          this.canvas.width=width;
          this.canvas.height=height;
        }
        this.surface.drawImage(video,meta.backend==='regen'?width:0,0,width,height,0,0,width,height);
        this.latest={simTick:meta.simTick,observationId:`${meta.sessionId}:${meta.outputId}`,
          mapping:meta.mapping,ageMs:meta.ageMs,referenceSha256:meta.referenceSha256,
          camera:meta.input.camera,routeSignalState:meta.input.signalState??null,observation:meta.input.local};
        for (const item of this.waiting) if (this.latest.simTick>=item.minTick) item.finish();
      },
    });
    this.client.start(reference?{...context,referenceId:reference.sessionId,referenceSha256:reference.referenceSha256}:context);
  }

  next({minTick=0,timeoutMs=6000}={}) {
    if (this.closed) return Promise.reject(new Error('连续写实会话已关闭'));
    if (!Number.isSafeInteger(minTick)||minTick<0||!Number.isFinite(timeoutMs)||timeoutMs<=0) {
      return Promise.reject(new RangeError('无效的写实观测请求'));
    }
    return new Promise((resolve,reject)=>{
      const finish=error=>{
        clearTimeout(timer);
        this.waiting.delete(item);
        if (error) return reject(error);
        const frame=this.latest;
        this.canvas.toBlob(image=>image?resolve({...frame,image}):reject(new Error('写实图像编码失败')));
      };
      const item={minTick,finish};
      const timer=setTimeout(()=>finish(new Error('等待连续写实观测超时')),timeoutMs);
      this.waiting.add(item);
      if (this.latest?.simTick>=minTick) finish();
    });
  }

  close() {
    if (this.closed) return;
    this.closed=true;
    this.client.stop();
    for (const item of this.waiting) item.finish(new Error('连续写实会话已关闭'));
  }
}
