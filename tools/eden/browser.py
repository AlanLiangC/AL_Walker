"""Run CityNav in Chromium and persist browser-side metrics and paired video."""
import argparse
import asyncio
import base64
from collections import Counter
import json
from pathlib import Path
import statistics
from urllib.parse import urlencode

from playwright.async_api import async_playwright

REPO = Path(__file__).resolve().parents[2]
INSTRUMENT = """
window.edenLog=[];
addEventListener('citynav-eden',event=>edenLog.push(event.detail));
window.lastInputEvent=null;
for (const type of ['keydown','pointermove','wheel']) {
  addEventListener(type,event=>{
    if (type==='keydown'&&!['KeyW','KeyA','KeyD','Space'].includes(event.code)) return;
    if (type==='pointermove'&&!event.buttons) return;
    lastInputEvent={type,at:event.timeStamp};
  },true);
}
window.recordPair=()=>{
  const main=document.querySelector('#eden-main');
  const liveSource=document.querySelector('#viewport[data-eden-parallel] #scene');
  const draft=liveSource?document.createElement('canvas'):document.querySelector('#eden-draft');
  if (liveSource) {
    draft.width=main.width;
    draft.height=main.height;
    window.parallelDraft=draft;
    addEventListener('citynav-eden',copyOriginal);
  }
  function copyOriginal(event) {
    if (event.detail.type!=='parallel-original') return;
    draft.getContext('2d').drawImage(liveSource,0,0,draft.width,draft.height);
    recordFrame();
  }
  const canvas=document.createElement('canvas');
  const context=canvas.getContext('2d',{alpha:false});
  canvas.width=main.width*2;
  canvas.height=main.height;
  const video=canvas.captureStream(0);
  const track=video.getVideoTracks()[0];
  const pieces=[];
  const recorder=new MediaRecorder(video,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:6000000});
  recorder.ondataavailable=event=>pieces.push(event.data);
  function record(event) {
    if (event.detail.type==='present') recordFrame();
  }
  function recordFrame() {
    context.drawImage(draft,0,0,main.width,main.height);
    context.drawImage(main,main.width,0,main.width,main.height);
    track.requestFrame();
  }
  recorder.start();
  addEventListener('citynav-eden',record);
  window.stopPair=()=>new Promise(resolve=>{
    recorder.onstop=()=>{
      track.stop();
      removeEventListener('citynav-eden',copyOriginal);
      const reader=new FileReader();
      reader.onload=()=>resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(new Blob(pieces,{type:'video/webm'}));
    };
    removeEventListener('citynav-eden',record);
    recorder.stop();
  });
};
"""

SIGNATURE = """() => {
  const transform=window.CityNav;
  const source=transform.observe({frames:true});
  const policy=transform.policy.observe({frames:true});
  function hash(data) {
    if (!data) return null;
    const bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
    let result=2166136261;
    for (const byte of bytes) result=Math.imul(result^byte,16777619);
    return (result>>>0).toString(16);
  }
  function readings(sensors) {
    return sensors.map(sensor=>{
      const {frame,...other}=sensor;
      return {...other,frame:frame?{width:frame.width,height:frame.height,format:frame.format,hash:hash(frame.data)}:null};
    });
  }
  return { state:transform.snapshot(),sensors:readings(source.sensors),
    policy:readings(policy.sensors),trajectory:transform.trajectory() };
}"""


def percentiles(values):
    if not values:
        return {"n": 0, "p50": None, "p95": None}
    data = sorted(values)
    return {"n": len(data), "p50": statistics.median(data),
            "p95": data[max(0, (len(data)*95+99)//100-1)]}


def summarize(events, probes=(), interval=None):
    status = [e for e in events if e["type"] == "status"]
    outputs = [e for e in events if e["type"] == "present"]
    unpaired = [e for e in events if e["type"] == "unpaired"]
    late = [e for e in events if e["type"] == "drop" and e.get("reason") == "late"]
    if interval:
        low, high = interval
    elif outputs:
        low, high = outputs[0]["submittedAt"], outputs[-1]["submittedAt"]
    else:
        low = high = 0
    samples = [e for e in outputs if low <= e["submittedAt"] <= high]
    first = {}
    for event in outputs:
        first.setdefault(event["sessionId"], event)
    warms = [e for e in status if e["state"] == "warming"]
    connects = [e for e in status if e["state"] == "connecting"]
    warm_delay = []
    connection_delay = []
    for event in first.values():
        if matches := [row for row in warms if row["at"] <= event["submittedAt"]]:
            warm_delay.append(event["submittedAt"] - matches[-1]["at"])
        if matches := [row for row in connects if row["at"] <= event["submittedAt"]]:
            connection_delay.append(event["submittedAt"] - matches[-1]["at"])
    active_at = low
    live = False
    active = 0
    for event in status:
        at = min(high, max(low, event["at"]))
        if live:
            active += at-active_at
        live = event["state"] == "live"
        active_at = at
        if at >= high:
            break
    if live:
        active += max(0, high-active_at)
    mapped = len(outputs)+len(late)
    delivered = mapped+len(unpaired)
    sources = [e for e in events if e["type"] == "input" and low <= e["capturedAt"] <= high]
    frame_age = percentiles([e["ageMs"] for e in samples])
    input_age = percentiles([p["ms"] for p in probes if p.get("ms") is not None])
    fps = round(len(samples)*1000/(high-low), 2) if high > low else None
    availability = min(1,active/(high-low)) if high > low else None
    return {
        "rendered": len(outputs), "submitted": len(samples), "frameAgeMs": frame_age,
        "gpuMs": percentiles([e["workerMs"] for e in first_chunk_frames(samples)]),
        "firstFrameMs": percentiles(warm_delay), "connectionToFirstFrameMs": percentiles(connection_delay),
        "inputToScreenMs": input_age, "freshFps": fps,
        "pairRate": mapped/delivered if delivered else None, "availability": availability,
        "repeatedFrames": sum(e.get("reason")=="repeat" for e in unpaired),
        "captureFps": round(len(sources)*1000/(high-low), 2) if high > low else None,
        "partsMs": {key:percentiles([e[key] for e in group if key in e]) for key,group in (
            ("queueMs",samples),("serverAgeMs",samples),("packingMs",samples),
            ("anchorMs",first_chunk_frames(samples)),("dinoMs",first_chunk_frames(samples)),
            ("denoiseMs",first_chunk_frames(samples)),("decodeMs",first_chunk_frames(samples)))},
        "mapping": dict(Counter(e["mapping"] for e in outputs)),
        "drops": dict(Counter(e.get("reason","unknown") for e in events if e["type"] == "drop")),
        "fallback": [e for e in status if e["state"] == "fallback"],
        "playoutGapMs": percentiles([b["submittedAt"]-a["submittedAt"]
            for a,b in zip(samples,samples[1:]) if a["sessionId"]==b["sessionId"]]),
        "rtcp": [e for e in events if e["type"] == "rtc-stats"],
        "meetsInteractiveTargets": bool(warm_delay and percentiles(warm_delay)["p95"] <= 8000
            and fps and fps >= 20 and frame_age["n"] and frame_age["p95"] <= 800
            and input_age["n"] >= 30 and input_age["p95"] <= 800
            and delivered and mapped/delivered >= .95 and availability and availability >= .95),
    }


def first_chunk_frames(frames):
    first = {}
    for frame in frames:
        first.setdefault((frame["sessionId"], frame["chunk"]), frame)
    return first.values()


async def open_city(page, url, replay=False, episode=None):
    await page.add_init_script(INSTRUMENT)
    query = {"eden": "/eden", "edenLegacy": "1", "edenDiagnostics": "1"}
    if replay:
        query["edenReplay"] = "1"
    if episode:
        query["episode"] = episode
    await page.goto(url.rstrip("/") + "/src/?" + urlencode(query))
    await page.wait_for_function("!!window.CityNav", timeout=30000)
    assert not await page.locator("#app-error").is_visible()


async def live(page, timeout=35000):
    await page.wait_for_function("document.querySelector('#viewport').hasAttribute('data-eden-live')", timeout=timeout)


async def setup_episode(page, episode, robot="go2"):
    await page.locator("#benchmark-library").click()
    await page.locator("#scene-select").select_option("extreme" if "-x" in episode else episode.rsplit("-",1)[0])
    await page.locator("#task-select").select_option(episode)
    await page.locator("#robot-select").select_option(robot)
    await page.locator("#setup button[type=submit]").click()
    await page.wait_for_function("!document.querySelector('#setup').open")


async def jump_probe(page, index, timeout):
    previous = await page.evaluate("edenLog.findLast(e=>e.type==='input')")
    if previous is None:
        return {"kind": "probe", "ms": None}
    scene = await page.locator("#scene").bounding_box()
    x, y = scene["x"]+scene["width"]*.53, scene["y"]+scene["height"]*.52
    kind = ("wheel", "pointermove", "keydown")[index % 3]
    await page.evaluate("lastInputEvent=null")
    if kind == "wheel":
        await page.mouse.move(x,y)
        await page.mouse.wheel(0,45 if index % 2 else -45)
    elif kind == "pointermove":
        await page.mouse.move(x,y)
        await page.mouse.down()
        await page.mouse.move(x+(21 if index % 2 else -21),y+2)
        await page.mouse.up()
    else:
        await page.keyboard.down("a" if index % 2 else "d")
    data = {"kind": kind, "ms": None}
    try:
        await page.wait_for_function("""({previous,kind})=>lastInputEvent?.type===kind && edenLog.some(e=>
            e.type==='present'&&e.input.capturedAt>=lastInputEvent.at&&e.input.inputRevision>previous.inputRevision&&
            JSON.stringify(e.input.camera)!==JSON.stringify(previous.camera))""",
            arg={"previous":previous,"kind":kind}, timeout=timeout)
        data.update(await page.evaluate("""previous=>{
          const input=lastInputEvent;
          const e=edenLog.find(e=>e.type==='present'&&e.input.capturedAt>=input.at&&
            e.input.inputRevision>previous.inputRevision&&JSON.stringify(e.input.camera)!==JSON.stringify(previous.camera));
          return {ms:e.submittedAt-input.at,outputId:e.outputId,frameId:e.input.frameId,simTick:e.simTick,
            inputAt:input.at,submittedAt:e.submittedAt,epoch:e.epoch};
        }""",previous))
    except Exception as exc:
        data["failure"] = str(exc).splitlines()[0]
    finally:
        if kind=="keydown":
            await page.keyboard.up("a" if index % 2 else "d")
    return data


async def save_events(page, directory, filename, extra):
    try:
        events = await page.evaluate("edenLog")
    except Exception as error:
        events = []
        extra["eventReadError"] = repr(error)
    result = {**extra, "summary": summarize(events, extra.get("probes", []), extra.get("interval")), "events": events}
    (directory / filename).write_text(json.dumps(result, indent=2, ensure_ascii=False))
    return result


async def interactive(browser, args, directory):
    context = await browser.new_context(viewport={"width": 1200, "height": 780})
    page = await context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    result = {"checks": {}, "probes": [], "errors": errors}
    try:
        await open_city(page, args.url, episode=args.opening_episode)
        initial = await page.evaluate("CityNav.snapshot()")
        if args.opening_episode:
            await page.locator("[data-eden=compare]").click()
            await live(page)
        else:
            await page.locator("#run").click()
            await page.locator("[data-eden=compare]").click()
            await live(page)
        first = await page.evaluate("edenLog.find(e=>e.type==='present')")
        result["checks"]["matchedTimeline"] = first["input"]["simTick"] == first["simTick"]
        if args.opening_episode:
            result["checks"]["matchedOpeningReference"] = first["reference"] == "reference" and first["simTick"] == 0
            await page.locator("#run").click()
        if args.video:
            await page.evaluate("recordPair()")
        await page.keyboard.down("w")
        await page.wait_for_timeout(800)
        await page.keyboard.up("w")
        moved = await page.evaluate("CityNav.snapshot()")
        result["checks"]["driving"] = moved["traveled"] > initial["traveled"]
        if args.opening_episode:
            await page.wait_for_function("edenLog.some(e=>e.type==='present'&&e.simTick>0)", timeout=10000)
            driving = await page.evaluate("edenLog.find(e=>e.type==='present'&&e.simTick>0)")
            result["checks"]["openingSessionRetained"] = driving["sessionId"] == first["sessionId"]
            result["checks"]["openingSignalCue"] = first["signalCue"] == initial["navigation"]["signal"]["state"]
        result["interval"] = [await page.evaluate("performance.now()")]
        for index in range(args.probes):
            result["probes"].append(await jump_probe(page,index,args.probe_timeout))
        result["interval"].append(await page.evaluate("performance.now()"))
        if args.video:
            video = await page.evaluate("stopPair()")
            (directory / "interactive-paired.webm").write_bytes(base64.b64decode(video))
        await page.screenshot(path=directory / "interactive-paired.png")
        if args.no_faults:
            return
        await page.locator("[data-view=robot]").click()
        assert not await page.locator("#eden-output").is_visible()
        await live(page)
        robot = await page.evaluate("edenLog.findLast(e=>e.type==='present')")
        result["checks"]["newViewEpoch"] = robot["epoch"] > first["epoch"] and robot["sessionId"] != first["sessionId"]
        await page.locator("#reset-view").click()
        await live(page)
        reset = await page.evaluate("edenLog.findLast(e=>e.type==='present')")
        result["checks"]["resetView"] = reset["epoch"] > robot["epoch"]
        await page.keyboard.press("Escape")
        paused = await page.evaluate("CityNav.snapshot().time")
        await page.wait_for_timeout(300)
        result["checks"]["pause"] = paused == await page.evaluate("CityNav.snapshot().time") and not await page.locator("#eden-output").is_visible()
        await page.keyboard.press("Escape")
        await live(page)
        await page.locator("[data-view=overhead]").click()
        result["checks"]["overheadOriginal"] = not await page.locator("#eden-output").is_visible() and await page.locator("[data-eden=compare]").is_disabled()
        await page.locator("[data-view=robot]").click()
        await live(page)
        await setup_episode(page,args.episode)
        await live(page)
        selected = await page.evaluate("CityNav.snapshot()")
        context_id = await page.evaluate("edenLog.findLast(e=>e.type==='present').sessionId")
        result["checks"]["sceneSwitch"] = selected.get("episodeId") == args.episode
        if args.episode == "transit-09-x06":
            await page.evaluate("document.querySelector('#retry').click()")
            await live(page)
            result["checks"]["retry"] = context_id != await page.evaluate("edenLog.findLast(e=>e.type==='present').sessionId")
        # CDP offline blocks signaling, and close the ICE-selected session to
        # exercise media loss even on Chromium builds where offline keeps UDP.
        started = await page.evaluate("performance.now()")
        old = await page.evaluate("edenLog.findLast(e=>e.type==='present').sessionId")
        await context.set_offline(True)
        await page.request.post(args.url.rstrip("/")+"/eden/close", data={"sessionId": old})
        await page.wait_for_function("document.querySelector('#eden-status').dataset.state==='fallback'")
        fell = await page.evaluate("edenLog.findLast(e=>e.type==='status'&&e.state==='fallback').at")
        tick = await page.evaluate("CityNav.snapshot().time")
        await page.keyboard.down("w")
        await page.wait_for_timeout(500)
        await page.keyboard.up("w")
        result["fallbackMs"] = fell-started
        result["checks"]["fallbackOriginal"] = 0<=fell-started<=1000 and not await page.locator("#eden-output").is_visible()
        result["checks"]["fallbackDriving"] = await page.evaluate("CityNav.snapshot().time") > tick
        recovered = await page.evaluate("performance.now()")
        await context.set_offline(False)
        await live(page)
        playback = await page.evaluate("edenLog.findLast(e=>e.type==='present')")
        result["recoveryMs"] = playback["submittedAt"]-recovered
        result["checks"]["newSessionAfterFailure"] = playback["sessionId"] != old
        await context.set_offline(True)
        await page.evaluate("""()=>{
          const {episodeId,robotId,seed}=CityNav.snapshot();
          CityNav.reset({episodeId,robotId,seed,recordTrajectory:true});
          let ticks=Math.floor((CityNav.snapshot().remainingTime-.45)*20);
          while (ticks>0) {
            const batch=Math.min(2000,ticks);
            CityNav.step({brake:true},batch);
            ticks-=batch;
          }
        }""")
        await page.locator("#run").click()
        await page.locator("#result").wait_for(state="visible",timeout=5000)
        result["checks"]["fallbackCanFinish"] = await page.evaluate("CityNav.snapshot().reason==='timeout'")
    except Exception as exc:
        result["failure"] = repr(exc)
    finally:
        await save_events(page,directory,"interactive.json",result)
        await context.close()
    print(json.dumps({k:v for k,v in result.items() if k!="probes"},ensure_ascii=False),flush=True)


async def replay(browser, args, directory, plan):
    page = await browser.new_page(viewport={"width": 1100, "height": 710})
    result = {"case": plan["episodeId"], "review": plan["review"], "checks": {}}
    if args.duration:
        plan["end"] = min(plan["end"], plan["start"]+round(args.duration*20))
        plan["actions"] = plan["actions"][:plan["end"]]
    try:
        await open_city(page,args.url,replay=True)
        await page.locator(f"[data-view={plan['view']}]").click()
        await page.evaluate("""plan=>{
          window.replayPlan=plan;
          CityNav.policy.reset(plan.config);
          for (const action of plan.actions.slice(0,plan.start)) CityNav.policy.step(action);
        }""",plan)
        await page.locator("[data-eden=parallel]" if args.parallel_view else "[data-eden=compare]").click()
        try:
            await live(page)
        except Exception:
            result["firstFrameTimeout"] = True
        if args.video and not result.get("firstFrameTimeout"):
            await page.evaluate("recordPair()")
            await page.evaluate("""plan=>{
              const requested=plan.reviewTicks??[plan.start+3,(plan.eventTick??plan.start+300)-20,
                plan.eventTick??plan.start+300,(plan.eventTick??plan.start+300)+20,plan.start+900];
              const targets=[...new Set(requested.filter(tick=>tick>=plan.start&&tick<=plan.end))].sort((a,b)=>a-b);
              window.reviewStills=[];
              addEventListener('citynav-eden',event=>{
                if (event.detail.type!=='present'||!targets.length||event.detail.simTick<targets[0]) return;
                const targetTick=targets.shift();
                const { simTick,sessionId,epoch,frameId,outputId,backend,input }=event.detail;
                const canvas=document.createElement('canvas');
                const draft=window.parallelDraft??document.querySelector('#eden-draft');
                const main=document.querySelector('#eden-main');
                canvas.width=main.width*2;
                canvas.height=main.height;
                const context=canvas.getContext('2d');
                context.drawImage(draft,0,0,main.width,main.height);
                context.drawImage(main,main.width,0,main.width,main.height);
                reviewStills.push({targetTick,simTick,originalTick:event.detail.originalTick,
                  sessionId,epoch,frameId,outputId,backend,camera:input.camera,
                  image:canvas.toDataURL().split(',')[1]});
              });
            }""",plan)
        if not result.get("firstFrameTimeout"):
            await page.screenshot(path=directory / f"{plan['episodeId']}-opening.png")
        timing = await page.evaluate("""async ()=>{
          const plan=replayPlan;
          const actions=plan.actions.slice(plan.start,plan.end);
          const started=performance.now();
          const probes=[];
          for (const [i,action] of actions.entries()) {
            await new Promise(resolve=>setTimeout(resolve,Math.max(0,started+i*50-performance.now())));
            if (i%10===0&&action.throttle>0) {
              const before=edenLog.findLast(event=>event.type==='input');
              if (before) probes.push({at:performance.now(),tick:plan.start+i+1,camera:before.camera});
            }
            CityNav.policy.step(action);
          }
          return {interval:[started,performance.now()],probes};
        }""")
        result["interval"] = timing["interval"]
        if args.parallel_view:
            result["parallel"] = await page.evaluate("""([start,end])=>{
              const interval=edenLog.filter(e=>(e.at??e.submittedAt)>=start&&(e.at??e.submittedAt)<=end);
              const originals=interval.filter(e=>e.type==='parallel-original');
              const ticks=[...new Set(originals.map(e=>e.simTick))];
              const skew=interval.filter(e=>e.type==='present'&&Number.isInteger(e.originalTick))
                .map(e=>e.originalTick-e.simTick);
              return {originalTicks:ticks.length,originalSimFps:ticks.length*1000/(end-start),skewTicks:skew};
            }""", result["interval"])
            result["checks"]["originalAdvancedIndependently"] = (
                result["parallel"]["originalTicks"] > 1 and any(tick > 0 for tick in result["parallel"]["skewTicks"])
            )
        result["probes"] = await page.evaluate("""items=>{
          const seen=new Set();
          const frames=edenLog.filter(e=>e.type==='present'&&['source','conditioned'].includes(e.mapping));
          return items.map(probe=>{
            const shown=frames.find(e=>e.simTick>=probe.tick&&e.input.capturedAt>=probe.at&&
              e.submittedAt-probe.at<9000&&JSON.stringify(e.input.camera)!==JSON.stringify(probe.camera)&&
              !seen.has(e.sessionId+'@'+e.outputId));
            if (shown) seen.add(shown.sessionId+'@'+shown.outputId);
            return {tick:probe.tick,at:probe.at,ms:shown?shown.submittedAt-probe.at:null,
              frameId:shown?.frameId,outputId:shown?.outputId,sessionId:shown?.sessionId};
          });
        }""",timing["probes"])
        if args.video and not result.get("firstFrameTimeout"):
            encoded = await page.evaluate("stopPair()")
            (directory / f"{plan['episodeId']}-paired.webm").write_bytes(base64.b64decode(encoded))
            stills = await page.evaluate("reviewStills")
            result["reviewStills"] = stills
            for still in stills:
                name = f"{plan['episodeId']}-review-{still['targetTick']}.png"
                (directory / name).write_bytes(base64.b64decode(still.pop("image")))
                still["file"] = name
                still["nearestTruth"] = min(plan["truth"], key=lambda row: abs(row["tick"]-still["simTick"]))
        enabled = await page.evaluate(SIGNATURE)
        await page.locator("[data-eden=original]").click()
        await page.evaluate("""plan=>{
          CityNav.policy.reset(plan.config);
          for (const action of plan.actions) CityNav.policy.step(action);
        }""",plan)
        disabled = await page.evaluate(SIGNATURE)
        result["checks"]["identicalStateTrajectoryAndObservations"] = enabled == disabled
        result["end"] = {"time": enabled["state"]["time"],"score": enabled["state"]["score"],"status": enabled["state"]["status"]}
    except Exception as exc:
        result["failure"]=repr(exc)
    finally:
        data=await save_events(page,directory,plan["episodeId"]+".json",result)
        await page.close()
    print(json.dumps({"case":plan["episodeId"],"summary":{k:v for k,v in data["summary"].items() if k!="rtcp"},
        "checks":result["checks"],"failure":result.get("failure")},ensure_ascii=False),flush=True)


async def offline(browser,directory):
    report={}
    for file in ["index.html","artillery.html"]:
        page = await browser.new_page(viewport={"width":1100,"height":710})
        errors=[]
        page.on("pageerror",lambda error: errors.append(str(error)))
        await page.route("http**",lambda route: route.abort())
        await page.goto((REPO / file).as_uri())
        await page.wait_for_function("!!window.CityNav",timeout=60000)
        await page.locator("#run").click()
        await page.keyboard.down("w")
        await page.wait_for_timeout(600)
        await page.keyboard.up("w")
        state=await page.evaluate("CityNav.snapshot()")
        report[file]={"time":state["time"],"traveled":state["traveled"],"errors":errors,
                      "enhancementHidden":not await page.locator("#eden-controls").is_visible()}
        assert state["time"]>0 and not errors
        await page.close()
    (directory/"offline.json").write_text(json.dumps(report,indent=2))
    print(json.dumps(report,ensure_ascii=False),flush=True)


async def main(args):
    directory=args.output
    directory.mkdir(parents=True,exist_ok=True)
    async with async_playwright() as driver:
        browser=await driver.chromium.launch(executable_path=args.chromium,args=[
            "--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader",
            "--autoplay-policy=no-user-gesture-required",
            "--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding",
            *args.chrome_arg,
        ])
        if args.offline:
            await offline(browser,directory)
        elif args.replays:
            files=[p for p in sorted(args.replays.glob("*.json")) if not args.only or p.stem in args.only]
            if args.parallel:
                await asyncio.gather(*(replay(browser,args,directory,json.loads(path.read_text())) for path in files))
            else:
                for path in files:
                    await replay(browser,args,directory,json.loads(path.read_text()))
        else:
            await interactive(browser,args,directory)
        await browser.close()


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url",default="http://127.0.0.1:8765")
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--chromium")
    parser.add_argument("--chrome-arg",action="append",default=[])
    parser.add_argument("--video",action="store_true")
    parser.add_argument("--offline",action="store_true")
    parser.add_argument("--no-faults",action="store_true")
    parser.add_argument("--probes",type=int,default=30)
    parser.add_argument("--probe-timeout",type=int,default=6000)
    parser.add_argument("--episode",default="transit-09-x06")
    parser.add_argument("--opening-episode", help="Check a configured reference from the ready screen")
    parser.add_argument("--replays",type=Path)
    parser.add_argument("--only",action="append")
    parser.add_argument("--parallel",action="store_true")
    parser.add_argument("--parallel-view",action="store_true",help="Replay in the live CityNav and enhanced layout")
    parser.add_argument("--duration",type=float)
    asyncio.run(main(parser.parse_args()))
