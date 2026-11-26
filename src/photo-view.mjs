async function jsonConfig(config,path) {
  const headers=config.token?{Authorization:'Bearer '+config.token}:{};
  const response=await fetch(config.endpoint+path,{headers,cache:'no-store',signal:AbortSignal.timeout(4000)});
  if (!response.ok) throw Error('HTTP '+response.status);
  return response.json();
}

export async function photoProfile(config) {
  if ((await jsonConfig(config,'/config')).photo) return jsonConfig(config,'/photo/config');
}

export async function renderPhoto(config,state,signal) {
  const key=crypto.randomUUID();
  const headers={'Content-Type':'application/json'};
  if (config.token) headers.Authorization='Bearer '+config.token;
  const res=await fetch(config.endpoint+'/photo/frame',{
    method:'POST',headers,body:JSON.stringify({...state,key}),signal,cache:'no-store',
  });
  if (!res.ok) throw Error('HTTP '+res.status);
  const method=res.headers.get('X-CityNav-Method');
  if (res.headers.get('X-CityNav-Frame')!==key||res.headers.get('X-CityNav-Tick')!==String(state.tick)||
      method!==state.method) {
    throw Error('渲染帧与仿真状态不匹配');
  }
  return { key,tick:state.tick,method,renderMs:Number(res.headers.get('X-CityNav-Render-Ms')),image:await res.blob() };
}

export class PhotoView {
  constructor(changed,paint) {
    this.changed=changed;
    this.paint=paint;
    this.revision=0;
    this.phase='off';
    this.frame=null;
  }

  invalidate() {
    this.revision++;
    this.frame=null;
    this.phase='off';
  }

  ready(tick) {
    return this.frame?.tick===tick;
  }

  capture(engine,request) {
    if (this.pending||this.ready(engine.ticks)||this.phase==='error') return;
    this.pending=this.paintNext(engine,request).finally(()=>{
      this.pending=null;
      this.changed();
    });
  }

  async paintNext(engine,request) {
    const revision=this.revision;
    this.phase='waiting';
    this.changed();
    try {
      const frame=await request();
      const image=await createImageBitmap(frame.image);
      try {
        if (this.revision!==revision||frame.tick!==engine.ticks) return;
        this.paint(image);
        this.frame=frame;
        this.phase='ready';
      } finally {
        image.close();
      }
    } catch {
      if (this.revision===revision) this.phase='error';
    }
  }
}
