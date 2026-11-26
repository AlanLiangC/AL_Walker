import { createCapture,makeTagReader,margin } from './eden-capture.mjs';

const idLimit=0xffffff;
const shortTimeout=2500;
const retention=12_000;

function waitForIce(peer,signal) {
  if (peer.iceGatheringState==='complete') return Promise.resolve();
  return new Promise((resolve,reject)=>{
    function finish(error) {
      clearTimeout(timer);
      peer.removeEventListener('icegatheringstatechange',check);
      signal.removeEventListener('abort',abort);
      if (error) reject(error);
      else resolve();
    }
    const check=()=>{ if (peer.iceGatheringState==='complete') finish(); };
    const abort=()=>finish(signal.reason);
    const timer=setTimeout(()=>finish(peer.localDescription?.sdp.includes('a=candidate:')
      ? undefined : Error('ICE 采集超时')),5000);
    peer.addEventListener('icegatheringstatechange',check);
    signal.addEventListener('abort',abort,{ once:true });
  });
}

export function configuredEden() {
  if (!isSecureContext||!/^https?:$/.test(location.protocol)||!globalThis.RTCPeerConnection||
      !HTMLVideoElement.prototype.requestVideoFrameCallback) return null;
  const config=window.CityNavEdenConfig;
  const endpoint=config?.endpoint??document.querySelector('meta[name="citynav-eden"]')?.content
    ??new URLSearchParams(location.search).get('eden');
  if (!endpoint) return null;
  let url;
  try { url=new URL(endpoint,location.href); }
  catch { return null; }
  if (url.search||url.hash||url.username||url.password) return null;
  if (url.protocol!=='https:'&&!(url.protocol==='http:'&&location.protocol==='http:'&&
      ['localhost','127.0.0.1','[::1]'].includes(location.hostname)&&
      ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) return null;
  // Only trusted application configuration may attach credentials.
  return { endpoint:url.href.replace(/\/$/,''),token:config?.endpoint?config.token:undefined,
    iceServers:config?.iceServers??[] };
}

export class EdenSession {
  constructor(config,callbacks) {
    this.config=config;
    this.callbacks=callbacks;
    this.epoch=0;
    this.session=null;
    this.attempt=0;
    this.readTag=makeTagReader();
  }

  async request(path,options,signal) {
    const headers={ ...options.headers };
    if (this.config.token) headers.Authorization='Bearer '+this.config.token;
    const res=await fetch(this.config.endpoint+path,{ ...options,headers,signal,cache:'no-store' });
    if (!res.ok) throw Error('HTTP '+res.status);
    return res.json();
  }

  status(name,detail='') {
    this.callbacks.status(name,detail);
  }

  start(context) {
    this.stop();
    this.context=context;
    this.attempt=0;
    this.connect();
  }

  stop() {
    this.context=null;
    clearTimeout(this.retry);
    this.close();
    this.status('off');
  }

  close() {
    const session=this.session;
    if (!session) return;
    this.session=null;
    clearInterval(session.watch);
    session.abort.abort();
    session.socket?.close();
    session.channel?.close();
    session.peer?.close();
    session.capture?.stop();
    if (session.video) {
      session.video.pause();
      session.video.srcObject=null;
    }
    if (session.admitted) {
      this.request('/close',{ method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},
        body:JSON.stringify({sessionId:session.id}) },AbortSignal.timeout(1200)).catch(()=>{});
    }
  }

  fail(session,reason) {
    if (this.session!==session) return;
    this.close();
    this.status('fallback',reason);
    const delay=Math.min(5000,600*2**this.attempt++);
    this.retry=setTimeout(()=>this.connect(),delay);
  }

  async connect() {
    if (!this.context) return;
    const session={ id:crypto.randomUUID(),epoch:++this.epoch,abort:new AbortController(),
      single:!!this.context.referenceId,referenceSha256:this.context.referenceSha256,
      rendererQuery:this.context.renderer?'?renderer='+encodeURIComponent(this.context.renderer):'',
      sent:new Map(),outputs:new Map(),next:0,lastPresented:0,received:0,paired:0,stamp:performance.now() };
    this.session=session;
    this.status('connecting');
    const signal=session.abort.signal;
    try {
      const profile=await this.request('/config'+session.rendererQuery,{},AbortSignal.any([signal,AbortSignal.timeout(shortTimeout)]));
      session.profile=profile;
      if ((session.single||profile.backend==='regen')&&profile.direct&&!this.config.token&&new URL(this.config.endpoint).origin===location.origin&&
          !new URLSearchParams(location.search).has('edenRtc')) {
        this.connectSocket(session);
        return;
      }
      session.capture=createCapture(profile);
      const peer=session.peer=new RTCPeerConnection({ iceServers:this.config.iceServers });
      const transceiver=peer.addTransceiver(session.capture.track,{direction:'sendrecv'});
      const sender=transceiver.sender;
      const codecs=RTCRtpReceiver.getCapabilities?.('video')?.codecs??[];
      const h264=codecs.filter(codec=>codec.mimeType.toLowerCase()==='video/h264');
      if (h264.length) transceiver.setCodecPreferences?.([...h264,...codecs.filter(codec=>!h264.includes(codec))]);
      session.channel=peer.createDataChannel('citynav');
      session.channel.onmessage=event=>this.message(session,event);
      session.channel.onopen=()=>{
        if (this.session!==session) return;
        session.warmAt=performance.now();
        this.status('warming',profile.backend);
      };
      session.channel.onclose=()=>this.fail(session,'数据通道关闭');
      peer.onconnectionstatechange=()=>{
        if (['failed','disconnected','closed'].includes(peer.connectionState)) this.fail(session,'连接中断');
      };
      peer.ontrack=event=>this.receive(session,event.track);
      await peer.setLocalDescription(await peer.createOffer());
      await waitForIce(peer,signal);
      const answer=await this.request('/offer',{ method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ ...peer.localDescription.toJSON(),sessionId:session.id,
          epoch:session.epoch,context:this.context }) },AbortSignal.any([signal,AbortSignal.timeout(5000)]));
      session.admitted=true;
      if (this.session!==session) return;
      await peer.setRemoteDescription(answer);
      const parameters=sender.getParameters();
      if (parameters.encodings?.length) {
        parameters.degradationPreference='maintain-resolution';
        if (profile.bitrate) parameters.encodings[0].maxBitrate=profile.bitrate*2;
        await sender.setParameters(parameters);
      }
      session.watch=setInterval(()=>this.watch(session),150);
    } catch (error) {
      this.fail(session,error.message);
    }
  }

  connectSocket(session) {
    const {width,height,fps}=session.profile;
    const canvas=document.createElement('canvas');
    canvas.width=width;
    canvas.height=height;
    const surface=canvas.getContext('2d',{alpha:false});
    const socket=session.socket=new WebSocket(this.config.endpoint.replace(/^http/,'ws')+'/live'+session.rendererQuery);
    socket.binaryType='arraybuffer';
    socket.onopen=()=>socket.send(JSON.stringify({sessionId:session.id,epoch:session.epoch,context:this.context}));
    socket.onmessage=event=>this.receiveSocket(session,event.data);
    socket.onclose=event=>this.fail(session,event.code===1013?'GPU 正在预热或繁忙':'媒体连接中断');
    const period=1000/fps;
    let next=-Infinity,encoding=false;
    session.capture={width,height,due:now=>!encoding&&now>=next-2,stop() {},
      send(image,input,now) {
        next=now-next>2*period?now+period:next+period;
        surface.drawImage(image,0,0,width,height);
        encoding=true;
        canvas.toBlob(blob=>{
          encoding=false;
          if (!blob||socket.readyState!==WebSocket.OPEN) return;
          const header=new TextEncoder().encode(JSON.stringify(input));
          const size=new Uint8Array(4);
          new DataView(size.buffer).setUint32(0,header.length);
          socket.send(new Blob([size,header,blob]));
        },'image/jpeg',.94);
      },
    };
    session.watch=setInterval(()=>this.watch(session),150);
  }

  async receiveSocket(session,data) {
    if (this.session!==session) return;
    if (typeof data==='string') {
      let message;
      try { message=JSON.parse(data); } catch { return; }
      if (message.type==='ready'&&message.sessionId===session.id&&message.epoch===session.epoch) {
        session.warmAt=performance.now();
        this.status('warming',session.profile.backend);
      } else this.message(session,{data});
      return;
    }
    const size=data.byteLength>=4?new DataView(data).getUint32(0):0;
    if (!size||size>4096||data.byteLength<=4+size) return;
    let output;
    try { output=JSON.parse(new TextDecoder().decode(new Uint8Array(data,4,size))); } catch { return; }
    const input=session.sent.get(output?.frameId);
    if (!input||output.sessionId!==session.id||output.epoch!==session.epoch||output.simTick!==input.simTick||
        output.referenceSha256!==session.referenceSha256) return;
    let image;
    try {
      image=await createImageBitmap(new Blob([new Uint8Array(data,4+size)],{type:'image/jpeg'}));
      const expectedWidth=session.profile.width*(session.profile.backend==='regen'?2:1);
      if (this.session!==session||output.outputId<=session.lastOutput||image.width!==expectedWidth||
          image.height!==session.profile.height) return;
      const now=performance.now(),ageMs=now-input.capturedAt;
      if (ageMs>session.profile.maxAgeMs) return;
      session.lastOutput=output.outputId;
      const first=!session.lastPresented;
      session.lastPresented=now;
      this.attempt=0;
      if (first) this.status('live',session.profile.backend);
      this.callbacks.present(image,{...output,input,ageMs,submittedAt:now,backend:session.profile.backend,
        tier:session.profile.tier,transport:'websocket'},session.profile);
    } catch { /* An incomplete media frame is skipped. */ }
    finally { image?.close(); }
  }

  watch(session) {
    const now=performance.now();
    const { warmAt,lastPresented,stamp,profile }=session;
    if (!warmAt&&now-stamp>6500) return this.fail(session,'连接超时');
    if (warmAt&&!lastPresented&&now-warmAt>profile.warmMs) return this.fail(session,'首帧超时');
    if (lastPresented&&now-lastPresented>profile.stallMs) return this.fail(session,'回显超时');
    for (const [id,input] of session.sent) if (now-input.capturedAt>retention) session.sent.delete(id);
    for (const [id,output] of session.outputs) if (now-output.receivedAt>retention) session.outputs.delete(id);
    if (session.peer&&this.callbacks.stats&&(!session.statsAt||now-session.statsAt>1000)) {
      session.statsAt=now;
      session.peer.getStats().then(reports=>{
        if (this.session!==session) return;
      const fields=['currentRoundTripTime','totalEncodeTime','framesEncoded','totalDecodeTime','framesDecoded','mimeType',
          'framesDropped','jitter','jitterBufferDelay','jitterBufferEmittedCount','packetsLost','qualityLimitationReason'];
        this.callbacks.stats({sessionId:session.id,epoch:session.epoch,at:now,reports:[...reports.values()]
          .filter(item=>item.type==='candidate-pair'&&item.nominated||['outbound-rtp','inbound-rtp','codec'].includes(item.type))
          .map(item=>({type:item.type,...Object.fromEntries(fields.filter(key=>key in item).map(key=>[key,item[key]]))}))});
      }).catch(()=>{});
    }
  }

  capture(now,render) {
    const session=this.session;
    if (!session) return false;
    const direct=!!session.socket;
    if (direct?(!session.warmAt||session.socket.readyState!==WebSocket.OPEN||session.socket.bufferedAmount>512_000):
        (session.channel?.readyState!=='open'||session.channel.bufferedAmount>64_000)) return false;
    if (!session.capture.due(now)) return false;
    const frameId=++session.next;
    if (frameId>=idLimit) {
      this.fail(session,'重新同步帧编号');
      return false;
    }
    const { image,local,...metadata }=render(session.capture);
    const input={ ...metadata,type:'input',sessionId:session.id,epoch:session.epoch,frameId,capturedAt:now };
    session.sent.set(frameId,{...input,local});
    if (direct) session.capture.send(image,input,now);
    else {
      session.channel.send(JSON.stringify(input));
      session.capture.send(image,frameId,now);
    }
    this.callbacks.input?.(input);
    return true;
  }

  message(session,event) {
    if (session!==this.session) return;
    let message;
    try { message=JSON.parse(event.data); }
    catch { return; }
    if (!message) return;
    if (message.sessionId!==session.id||message.epoch!==session.epoch) return;
    if (message.type==='failure') return this.fail(session,message.reason);
    if (message.type==='drop') return this.callbacks.drop?.(message);
    if (message.type!=='output') return;
    message.receivedAt=performance.now();
    session.outputs.set(message.outputId,message);
  }

  receive(session,track) {
    if (this.session!==session||track.kind!=='video') return;
    const video=session.video=document.createElement('video');
    video.muted=true;
    video.playsInline=true;
    video.srcObject=new MediaStream([track]);
    video.play().catch(error=>this.fail(session,error.message));
    const render=(now,info)=>{
      if (this.session!==session) return;
      video.requestVideoFrameCallback(render);
      const { width,height,maxAgeMs }=session.profile;
      const encodedWidth=session.single?width:width*2;
      session.received++;
      if (info.width!==encodedWidth||info.height!==height+margin) {
        this.callbacks.unpaired?.({reason:'resolution',width:info.width,height:info.height,
          rtpTimestamp:info.rtpTimestamp,mediaTime:info.mediaTime});
        return;
      }
      const outputId=this.readTag(video,height,encodedWidth);
      const output=session.outputs.get(outputId);
      const input=session.sent.get(output?.frameId);
      if (!input||output.simTick!==input.simTick||outputId<=session.lastOutput||
          session.single&&output.referenceSha256!==session.referenceSha256) {
        this.callbacks.unpaired?.({ outputId,reason:outputId===session.lastOutput?'repeat':'no-mapping',
          rtpTimestamp:info.rtpTimestamp,mediaTime:info.mediaTime });
        return;
      }
      session.lastOutput=outputId;
      session.paired++;
      const submittedAt=info.presentationTime??now;
      const ageMs=now-input.capturedAt;
      const meta={ ...output,input,ageMs,submittedAt,mediaTime:info.mediaTime,rtpTimestamp:info.rtpTimestamp,
        paired:session.paired,received:session.received,backend:session.profile.backend,tier:session.profile.tier };
      if (ageMs>maxAgeMs) {
        this.callbacks.drop?.({ ...meta,reason:'late' });
        if (session.lastPresented||now-session.warmAt>session.profile.warmMs) this.fail(session,'超过画面时延预算');
        return;
      }
      const first=!session.lastPresented;
      session.lastPresented=now;
      this.attempt=0;
      if (first) this.status('live',session.profile.backend);
      this.callbacks.present(video,meta,session.profile);
    };
    track.onended=()=>this.fail(session,'视频轨结束');
    video.requestVideoFrameCallback(render);
  }
}
