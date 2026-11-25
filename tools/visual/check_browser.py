"""Verify browser keyboard rendering and a navigation step using a real image."""
import argparse
import asyncio
import base64
import json
from pathlib import Path

from playwright.async_api import async_playwright


async def run(args):
    args.output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(args=[
            "--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=vulkan",
            "--enable-features=Vulkan", "--disable-vulkan-surface", "--disable-gpu-sandbox",
        ])
        page = await browser.new_page(viewport={"width": 1320, "height": 840})
        await page.add_init_script("""
          window.photoLog=[];
          addEventListener('citynav-eden',e=>{
            if(e.detail.type==='photo-present') photoLog.push({...e.detail,time:CityNav.snapshot().time});
          });
        """)
        path = "/src/?scene=scan" if args.scan else "/src/?eden=/eden&episode=office-09-x05&view=robot"
        await page.goto(args.url + path + "&edenDiagnostics=1")
        button = page.locator("[data-eden=photo]")
        if not args.scan:
            await button.wait_for(state="visible",timeout=20_000)
            assert await page.locator("#eden-controls [data-eden]:visible").all_text_contents() == ["原画", "写实闭环"]
            assert await page.locator("#scene-switch").is_hidden()
        await button.click(timeout=20_000)
        await page.wait_for_function("photoLog.length>0", timeout=130_000)
        await page.screenshot(path=args.output / "keyboard-start.png")
        after_first_request = asyncio.Event()
        check_frozen = {}

        async def delayed_one_frame(route):
            if not after_first_request.is_set():
                before = await page.evaluate("CityNav.snapshot().time")
                await page.keyboard.press("a")
                await asyncio.sleep(.45)
                check_frozen["heldWhileWaiting"] = before == await page.evaluate("CityNav.snapshot().time")
                after_first_request.set()
            await route.continue_()

        if args.scan:
            await page.evaluate("""()=>{
              window.scanHeld=null;
              const convert=OffscreenCanvas.prototype.convertToBlob;
              OffscreenCanvas.prototype.convertToBlob=async function(options) {
                if(options?.type==='image/png'&&window.scanHeld===null) {
                  window.scanHeld=false;
                  const before=CityNav.snapshot().time;
                  await new Promise(resolve=>setTimeout(resolve,450));
                  window.scanHeld=before===CityNav.snapshot().time;
                }
                return convert.call(this,options);
              };
            }""")
        else:
            await page.route("**/photo/frame", delayed_one_frame)
        before = await page.evaluate("CityNav.snapshot()")
        await page.locator("#run").click()
        await page.keyboard.down("w")
        if args.scan:
            await page.wait_for_function("window.scanHeld===false")
            await page.keyboard.press("a")
        await page.wait_for_function("CityNav.snapshot().traveled>.9 && photoLog.length>=18", timeout=130_000)
        await page.keyboard.up("w")
        await page.keyboard.press("Escape")
        await page.wait_for_function("document.querySelector('#viewport').hasAttribute('data-eden-live')", timeout=130_000)
        after = await page.evaluate("CityNav.snapshot()")
        await page.screenshot(path=args.output / "keyboard-after.png")
        frames = await page.evaluate("photoLog")
        state = {
            "heldWhileWaiting": await page.evaluate("window.scanHeld") if args.scan else check_frozen.get("heldWhileWaiting"),
            "steeredWithRenderedView": after["traveled"] > before["traveled"],
            "shortTurnApplied": abs(after["player"]["yaw"] - before["player"]["yaw"]) > .01,
            "eachDisplayedFrameMatchesState": all(round(frame["time"] * 20) == frame["simTick"] for frame in frames),
            "frames": frames,
        }
        assert all(state[key] for key in ("heldWhileWaiting", "steeredWithRenderedView", "shortTurnApplied",
                                          "eachDisplayedFrameMatchesState")), state
        if not args.scan:
            await page.unroute("**/photo/frame")
        nav = await page.evaluate("""async scan=>{
          const reset={...(scan?{taskId:'artillery'}:{episodeId:'office-09-x05'}),robotId:'go2',recordTrajectory:true};
          CityNav.policy.reset(reset);
          const keyboardPanelReleased=document.querySelector('[data-eden=photo]').disabled;
          const result=[];
          let frame=await CityNav.rendered.observe();
          for(let i=0;i<6;i++){
            const bmp=await createImageBitmap(frame.image);
            const canvas=document.createElement('canvas');
            canvas.width=32;canvas.height=16;
            const ctx=canvas.getContext('2d');
            ctx.drawImage(bmp,0,0,32,16);
            bmp.close();
            const source=ctx.getImageData(0,0,32,16).data;
            const checksum=source.reduce((hash,value)=>Math.imul(hash^value,16777619),2166136261)>>>0;
            const speed=source[32*8*4+16]>80?.60:.38;
            const old=frame;
            frame=await CityNav.rendered.step({throttle:speed,turn:0},{observationId:old.observationId,ticks:3});
            result.push({before:old.simTick,after:frame.simTick,checksum,throttle:speed,renderMs:frame.renderMs});
            try {
              await CityNav.rendered.step({throttle:1},{observationId:old.observationId,ticks:1});
              throw Error('允许了重复决策');
            } catch(error) {
              if(error.message!=='写实观测已失效') throw error;
            }
          }
          const replay=CityNav.snapshot();
          CityNav.policy.reset(reset);
          for(const action of result) CityNav.policy.step({throttle:action.throttle,turn:0},3);
          const plain=CityNav.snapshot();
          const asBase64=image=>new Promise(resolve=>{
            const reader=new FileReader();
            reader.onload=()=>resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(image);
          });
          const png=await asBase64(frame.image);
          let collision=null;
          if(scan) {
            CityNav.policy.reset(reset);
            const approach=[
              [{throttle:.65},25],[{throttle:.65,turn:.12},12],[{throttle:.65},48],[{throttle:.65},12],
            ];
            let contactFrame=await CityNav.rendered.observe();
            const steps=[];
            for(const [action,ticks] of approach) {
              contactFrame=await CityNav.rendered.step(action,{observationId:contactFrame.observationId,ticks});
              const state=CityNav.snapshot();
              steps.push({tick:contactFrame.simTick,position:state.player,camera:contactFrame.camera,events:state.events});
            }
            const contactState=CityNav.snapshot();
            CityNav.policy.reset(reset);
            for(const [action,ticks] of approach) CityNav.policy.step(action,ticks);
            collision={steps,sameState:JSON.stringify(contactState)===JSON.stringify(CityNav.snapshot()),
              png:await asBase64(contactFrame.image)};
          }
          return {decisions:result,keyboardPanelReleased,sameState:JSON.stringify(replay)===JSON.stringify(plain),
            traveled:replay.traveled,png,collision};
        }""", args.scan)
        assert nav["sameState"] and nav["keyboardPanelReleased"] and nav["traveled"] > 0
        assert all(r["after"]-r["before"] == 3 for r in nav["decisions"])
        if args.scan:
            collision = nav["collision"]
            assert collision["sameState"] and collision["steps"][-2]["events"] == []
            final = collision["steps"][-1]
            assert final["position"]["speed"] == 0 and final["events"][0]["detail"] == "石柱"
            assert final["camera"]["eye"][1] > final["position"]["y"]
            (args.output / "collision.png").write_bytes(base64.b64decode(collision.pop("png")))
        (args.output / "navigation.png").write_bytes(base64.b64decode(nav.pop("png")))
        (args.output / "browser.json").write_text(json.dumps({"keyboard": state, "navigation": nav}, indent=2) + "\n")
        print("Verified keyboard", len(frames), "frames and", len(nav["decisions"]), "navigation decisions")
        await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8771")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--scan", action="store_true")
    asyncio.run(run(parser.parse_args()))
