// Standalone browser test strategy. A decision uses the delivered sensor image
// and a separately captured vision-model result bearing that sample's identity.
export async function sensorTrial({ endpoint,episodeId,seed,mode,steps,timeoutMs }) {
  const { EdenSession }=await import('/src/eden-session.mjs');
  const sensors=[
    {id:'front',type:'rgb',forward:.16,height:.6,pitch:-10,fov:86,rateHz:10,latencyMs:100},
    {id:'imu',type:'imu',rateHz:20,latencyMs:50},
    {id:'gps',type:'gps',rateHz:5,latencyMs:250},
  ];
  const scene={episodeId,seed,robotId:'go2',sensors,recordTrajectory:true};
  const policy=CityNav.policy;
  policy.reset(scene);
  policy.step({brake:true},2);
  const source=document.createElement('canvas');
  const sourceContext=source.getContext('2d');
  const fitted=document.createElement('canvas');
  const fittedContext=fitted.getContext('2d');
  const enhanced=document.createElement('canvas');
  const enhancedContext=enhanced.getContext('2d',{willReadFrequently:true});
  let sample=null, pending=null, animation;
  const statuses=[],timeline=[];
  const client=mode==='raw'?null:new EdenSession({endpoint,iceServers:[]},{
    status(state,reason) { statuses.push({state,reason,at:performance.now()}); },
    present(video,meta,profile) {
      if (mode==='timeout'||!pending||!sample||meta.input.sampleId!==sample.id||
          meta.simTick!==sample.tick||!['conditioned','source'].includes(meta.mapping)) return;
      const {width,height}=profile;
      const padding=fit(width,height,source.width,source.height);
      enhanced.width=source.width;
      enhanced.height=source.height;
      enhancedContext.drawImage(video,width+padding.x,padding.y,padding.width,padding.height,
        0,0,enhanced.width,enhanced.height);
      pending.resolve({ data:enhancedContext.getImageData(0,0,enhanced.width,enhanced.height).data,
        frame:{sessionId:meta.sessionId,frameId:meta.frameId,epoch:meta.epoch,outputId:meta.outputId,
          simTick:meta.simTick,eventSample:meta.input.sampleId,backend:meta.backend,mapping:meta.mapping,ageMs:meta.ageMs} });
    },
  });

  function fit(width,height,imageWidth,imageHeight) {
    const scale=Math.min(width/imageWidth,height/imageHeight);
    const w=Math.round(imageWidth*scale),h=Math.round(imageHeight*scale);
    return {x:Math.floor((width-w)*.5),y:Math.floor((height-h)*.5),width:w,height:h};
  }

  function provide(now) {
    if (sample&&pending) client.capture(now,({width,height})=>{
      if (fitted.width!==width||fitted.height!==height) { fitted.width=width; fitted.height=height; }
      const area=fit(width,height,source.width,source.height);
      fittedContext.fillStyle='black';
      fittedContext.fillRect(0,0,width,height);
      fittedContext.drawImage(source,area.x,area.y,area.width,area.height);
      return { image:fitted,simTick:sample.tick,sampleId:sample.id,camera:sample.pose };
    });
    animation=requestAnimationFrame(provide);
  }

  function decide(data,width,height) {
    // Compare local edge energy from the two sides of the camera's lower half.
    const edge=[0,0];
    let signature=2166136261;
    for (let y=Math.round(height*.59);y<height*.85;y+=3) {
      for (let x=Math.round(width*.2);x<width*.8;x+=3) {
        const pixel=(y*width+x)*4;
        const contrast=Math.abs(data[pixel]-data[pixel-4])+Math.abs(data[pixel+1]-data[pixel-3]);
        edge[Number(x>=width*.5)]+=contrast;
        signature=Math.imul(signature^data[pixel]^data[pixel+1]<<8,16777619);
      }
    }
    const direction=edge[1]>edge[0]?-1:1;
    const diff=Math.abs(edge[1]-edge[0])/Math.max(1,edge[0]+edge[1]);
    return { action:{ throttle:edge[0]+edge[1]>2000?.22:.09,turn:direction*Math.max(.06,Math.min(.28,diff)),brake:false },
      signature:(signature>>>0).toString(16),edge };
  }

  if (client) {
    client.start({episodeId,seed,cameraMode:'sensor',weather:'day'});
    animation=requestAnimationFrame(provide);
  }
  try {
    for (let decision=0;decision<steps;decision++) {
      const before=CityNav.snapshot();
      const obs=policy.observe({frames:true});
      const rgb=obs.sensors.find(s=>s.id==='front');
      if (!rgb?.frame) throw Error('RGB sample was not delivered');
      const { width,height,data }=rgb.frame;
      const pose=CityNav.observe().sensors.find(s=>s.id==='front').pose;
      sample={id:'front@'+Math.round(rgb.sampleTime*20),tick:Math.round(rgb.sampleTime*20),pose};
      source.width=width;
      source.height=height;
      sourceContext.putImageData(new ImageData(new Uint8ClampedArray(data),width,height),0,0);
      let result=null;
      const started=performance.now();
      if (client) {
        let timer;
        result=await new Promise(resolve=>{
          pending={ resolve };
          timer=setTimeout(()=>resolve(null),timeoutMs);
        });
        clearTimeout(timer);
        pending=null;
      }
      const decisionAt=performance.now();
      const { action,signature,edge }=decide(result?.data??data,width,height);
      const inferenceMs=performance.now()-decisionAt;
      policy.step(action,4);
      const after=CityNav.snapshot();
      timeline.push({
        decision,decisionTick:Math.round(obs.time*20),sampleId:sample.id,sampleTick:sample.tick,
        sampleTime:rgb.sampleTime,pose,
        sensors:obs.sensors.map(s=>({id:s.id,sampleTime:s.sampleTime,available:s.available})),
        used:result?(result.frame.backend==='edenlive'?'edenlive':'passthrough'):mode==='raw'?'raw':'raw-timeout',
        frame:result?.frame,signature,edge,action,waitMs:decisionAt-started,inferenceMs,
        before:before.player,after:after.player,result:after.status,events:after.events,score:after.score,
      });
    }
    return {mode,episodeId,seed,statuses,timeline,trajectory:CityNav.trajectory(),final:CityNav.snapshot()};
  } finally {
    cancelAnimationFrame(animation);
    client?.stop();
  }
}
