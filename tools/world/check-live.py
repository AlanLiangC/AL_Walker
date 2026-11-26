"""Measure the browser's real keyboard-to-image loop on an authored reference."""
import argparse
import asyncio
import base64
import json
from pathlib import Path
from statistics import median, quantiles
from urllib.parse import urlencode

from playwright.async_api import async_playwright


def p95(values):
    return round(quantiles(values, n=100, method="inclusive")[94], 1) if len(values) > 1 else None


async def check_navigation(page, output, episode, style):
    await page.wait_for_function("!!window.CityNav")
    result = await page.evaluate("""async({episode,style})=>{
      CityNav.policy.reset({episodeId:episode,robotId:'go2'});
      const live=await CityNav.rendered.openLive({style});
      const frames=[await live.next({timeoutMs:30_000})];
      const preview=new OffscreenCanvas(8,6),context=preview.getContext('2d',{willReadFrequently:true});
      const actions=[];
      for(let i=0;i<3;i++) {
        const image=await createImageBitmap(frames.at(-1).image);
        context.drawImage(image,0,0,8,6);
        image.close();
        const data=context.getImageData(0,0,8,6).data;
        const brightness=(from,to)=>{
          let sum=0;
          for(let y=2;y<5;y++) for(let x=from;x<to;x++) sum+=data[(y*8+x)*4+1];
          return sum/(3*(to-from));
        };
        const contrast=brightness(4,8)-brightness(0,4);
        const action={throttle:.50,turn:Math.max(-.25,Math.min(.25,contrast/256))};
        actions.push({observedTick:frames.at(-1).simTick,contrast,action});
        const state=CityNav.policy.step(action,4);
        frames.push(await live.next({minTick:Math.round(state.time*20)}));
      }
      live.close();
      const observations=await Promise.all(frames.map(async({camera,observation,image,...meta})=>({
        ...meta,camera,observationTime:observation.time,
        png:await new Promise(resolve=>{
          const reader=new FileReader(); reader.onload=()=>resolve(reader.result.split(',')[1]); reader.readAsDataURL(image);
        }),
      })));
      return {actions,observations};
    }""", {"episode": episode, "style": style or
           "Documentary street photo in muted evening sun, dry road, warm reflections."})
    rows = result["observations"]
    assert [row["simTick"] for row in rows] == [0, 4, 8, 12]
    assert len({row["referenceSha256"] for row in rows}) == 1
    assert len({row["png"] for row in rows}) == len(rows)
    assert [row["observedTick"] for row in result["actions"]] == [0, 4, 8]
    for row in rows:
        assert round(row["observationTime"] * 20) == row["simTick"]
        assert row["mapping"] == ("reference" if row["simTick"] == 0 else "conditioned")
        (output / f"tick-{row['simTick']:02d}.png").write_bytes(base64.b64decode(row.pop("png")))
    (output / "navigator.json").write_text(json.dumps(rows, indent=2) + "\n")
    (output / "actions.json").write_text(json.dumps(result["actions"], indent=2) + "\n")
    print("Verified same-tick live navigator RGB at 0, 4, 8 and 12", flush=True)


async def check(args):
    args.output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle",
                                                  "--use-angle=vulkan", "--disable-vulkan-surface"])
        page = await browser.new_page(viewport={"width": 1400, "height": 930})
        await page.add_init_script("""
          window.log=[];
          window.keys=[];
          addEventListener('citynav-eden',e=>log.push(e.detail));
          for(const kind of ['keydown','keyup']) addEventListener(kind,e=>{
            if((e.code.startsWith('Key')||e.code==='Space'||e.code.startsWith('Arrow'))&&!e.repeat&&window.CityNav) {
              keys.push({code:e.code,kind,at:performance.now()});
            }
          },true);
        """)
        if args.reconnect:
            await page.add_init_script("""(()=>{
              const Native=window.WebSocket;
              window.WebSocket=class extends Native {
                constructor(url,...protocols) {
                  super(url,...protocols);
                  if(new URL(url).pathname.endsWith('/eden/live')) window.liveSocket=this;
                }
              };
            })();""")
        await page.goto(args.url + "/src/?" + urlencode({"eden": "/eden", "episode": args.episode, "view": "robot",
                                                         "edenDiagnostics": 1}) +
                        ("&renderBench=1" if args.projected else "") + ("&edenRtc=1" if args.rtc else "") +
                        ("&edenCompare=1" if args.parallel else ""))
        if args.external:
            await check_navigation(page, args.output, args.episode, args.style)
            await browser.close()
            return
        await page.locator("[data-eden=photo]").click(timeout=30_000)
        await page.locator("#photo-method").select_option("projected-photo" if args.projected else "eden-stream")
        await page.locator("#reference-prompt").fill(args.style or (
            "Photoreal street photography from a low robot camera shortly after rain. Wet dark asphalt, "
            "real glass and natural vehicle bodywork, partly cloudy sky, keep each traffic signal's correct color."
        ))
        reference_request = await page.evaluate("performance.now()")
        await page.locator("#reference-start").click()
        event_type = "projected-present" if args.projected else "present"
        await page.wait_for_function("(type)=>log.some(e=>e.type===type&&e.referenceSha256)", arg=event_type,
                                     timeout=240_000)
        reference_ready = await page.evaluate("""()=>{
          const reference=log.find(row=>row.type==='photo-present');
          const live=log.find(row=>row.type==='present'&&row.referenceSha256);
          return {generatedMs:reference?.renderMs,liveAt:live?.submittedAt??performance.now()};
        }""")
        await page.screenshot(path=args.output / "opening.png")
        if args.record:
            await page.evaluate("""()=>{
              const original=document.querySelector('#scene'),rendered=document.querySelector('#eden-main');
              const canvas=document.createElement('canvas'),context=canvas.getContext('2d',{alpha:false});
              canvas.width=rendered.width*2;
              canvas.height=rendered.height;
              const pending=new Map(),buffers=[];
              const pair=event=>{
                const row=event.detail;
                const key=row.sessionId+':'+row.frameId;
                if (row.type==='input') {
                  const source=buffers.pop()??document.createElement('canvas');
                  if (source.width!==rendered.width||source.height!==rendered.height) {
                    source.width=rendered.width;
                    source.height=rendered.height;
                  }
                  source.getContext('2d',{alpha:false}).drawImage(original,0,0,source.width,source.height);
                  pending.set(key,source);
                  if (pending.size>64) {
                    const oldest=pending.keys().next().value;
                    buffers.push(pending.get(oldest));
                    pending.delete(oldest);
                  }
                }
                if (row.type!=='present'||!pending.has(key)) return;
                const source=pending.get(key);
                context.drawImage(source,0,0);
                context.drawImage(rendered,canvas.width/2,0);
                pending.delete(key);
                buffers.push(source);
              };
              addEventListener('citynav-eden',pair);
              const stream=canvas.captureStream(24);
              const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:7_000_000});
              const data=[];
              recorder.ondataavailable=event=>data.push(event.data);
              recorder.start(250);
              window.finishRecording=()=>new Promise(resolve=>{
                recorder.onstop=()=>{
                  stream.getTracks().forEach(track=>track.stop());
                  const reader=new FileReader();
                  reader.onload=()=>resolve(reader.result.split(',')[1]);
                  reader.readAsDataURL(new Blob(data,{type:'video/webm'}));
                };
                removeEventListener('citynav-eden',pair);
                recorder.stop();
              });
            }""")
        await page.locator("#run").click()
        start = await page.evaluate("({at:performance.now(),world:CityNav.snapshot()})")
        route = (("w", 4), ("Space", 13.5), ("w", 7), ("d", .65), ("w", 4)) if args.journey else (
            ("w", 4), ("d", 2), ("w", 4), ("a", 2), ("w", 8))
        for index, (key, seconds) in enumerate(route):
            await page.keyboard.down(key)
            await asyncio.sleep(seconds)
            if not args.projected:
                pixels = await page.locator("#eden-main").evaluate("canvas=>canvas.toDataURL('image/png').split(',')[1]")
                (args.output / f"rgb-{index + 1}.png").write_bytes(base64.b64decode(pixels))
            await page.screenshot(path=args.output / f"action-{index + 1}.png")
            await page.keyboard.up(key)
        end = await page.evaluate("({at:performance.now(),world:CityNav.snapshot(),log,keys})")
        if args.reconnect:
            disconnected = await page.evaluate("""()=>{
              const at=performance.now();
              const sessionId=log.filter(row=>row.type==='present').at(-1).sessionId;
              const time=CityNav.snapshot().time;
              liveSocket.close();
              return {at,sessionId,time};
            }""")
            await page.wait_for_function("""old=>log.some(row=>row.type==='status'&&
              row.state==='fallback'&&row.at>=old.at)""", arg=disconnected)
            resumed = await page.wait_for_function("""old=>log.find(row=>row.type==='present'&&
              row.referenceSha256&&row.sessionId!==old.sessionId&&row.submittedAt>old.at)""",
                arg=disconnected, timeout=32_000)
            resumed = await resumed.json_value()
            assert resumed["simTick"] > round(disconnected["time"] * 20)
            assert resumed["mapping"] != "reference"
            (args.output / "recovery.json").write_text(json.dumps({"disconnected": disconnected, "resumed": resumed},
                                                                   indent=2) + "\n")
        if args.record:
            video = await page.evaluate("window.finishRecording()")
            (args.output / "original-and-generated.webm").write_bytes(base64.b64decode(video))
        await browser.close()

    elapsed = (end["at"] - start["at"]) / 1000
    if args.projected:
        frames = [item for item in end["log"] if item["type"] == "projected-present" and item["at"] >= start["at"]]
        assert frames and len({item["referenceSha256"] for item in frames}) == 1
        ages = [next((frame["at"] - event["at"] for frame in frames if frame["at"] >= event["at"]), None)
                for event in end["keys"] if event["at"] >= start["at"]]
        report = {"simStateFps": len({frame["simTick"] for frame in frames}) / elapsed,
                  "actionToSubmitP95Ms": p95([age for age in ages if age is not None]),
                  "renderSubmitP95Ms": p95([frame["renderMs"] for frame in frames]),
                  "traveledMetres": end["world"]["traveled"] - start["world"]["traveled"]}
        assert report["traveledMetres"] > 0 and report["simStateFps"] > 10
        (args.output / "results.json").write_text(json.dumps(report | {"frames": frames}, indent=2) + "\n")
        print(json.dumps(report, indent=2), flush=True)
        return
    presented = [item for item in end["log"] if item["type"] == "present" and item["submittedAt"] >= start["at"]]
    accepted = [item for item in presented if item.get("referenceSha256")]
    assert accepted and len({item["referenceSha256"] for item in accepted}) == 1
    assert all(item["simTick"] == item["input"]["simTick"] for item in accepted)
    if args.parallel:
        assert any(item["originalTick"] > item["simTick"] for item in accepted)
    assert end["world"]["traveled"] > start["world"]["traveled"]
    ages = [item["ageMs"] for item in accepted]
    actions = []
    for event in end["keys"]:
        if event["at"] < start["at"]:
            continue
        sample = next((item for item in accepted if item["input"]["capturedAt"] >= event["at"]
                       and item["mapping"] == "conditioned"), None)
        if sample:
            actions.append({**event, "conditionedImageMs": round(sample["submittedAt"] - event["at"], 1),
                            "simTick": sample["simTick"], "inputRevision": sample["input"]["inputRevision"]})
    report = {"seconds": elapsed, "fps": len(accepted) / elapsed,
              "simTickRate": (end["world"]["time"] - start["world"]["time"]) * 20 / elapsed,
              "uniqueStateFps": len({item["simTick"] for item in accepted}) / elapsed,
              "captureToDisplayP50Ms": median(ages), "captureToDisplayP95Ms": p95(ages),
              "actionToConditionedDisplayP95Ms": p95([item["conditionedImageMs"] for item in actions]),
              "traveledMetres": end["world"]["traveled"] - start["world"]["traveled"],
              "referenceGenerationMs": reference_ready.get("generatedMs"),
              "clickToLiveMs": round(reference_ready["liveAt"] - reference_request, 1),
              "events": end["world"]["events"], "endNavigation": end["world"]["navigation"],
              "actions": actions, "drops": [item for item in end["log"] if item["type"] == "drop"],
              "signalCorrectedFrames": sum(bool(item.get("correctedSignalRegions")) for item in accepted),
              "transport": accepted[0].get("transport", "webrtc"), "frames": accepted}
    (args.output / "results.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items()
                      if key not in ("actions", "drops", "frames", "endNavigation")}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8771")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--episode", default="office-09-x05")
    parser.add_argument("--style")
    parser.add_argument("--external", action="store_true")
    parser.add_argument("--projected", action="store_true")
    parser.add_argument("--rtc", action="store_true", help="force WebRTC for a transport comparison")
    parser.add_argument("--parallel", action="store_true", help="display the current original beside the generated frames")
    parser.add_argument("--journey", action="store_true", help="wait for the crossing before moving again")
    parser.add_argument("--record", action="store_true", help="record the original and rendered browser canvases")
    parser.add_argument("--reconnect", action="store_true", help="disconnect the live socket after the route and verify recovery")
    asyncio.run(check(parser.parse_args()))
