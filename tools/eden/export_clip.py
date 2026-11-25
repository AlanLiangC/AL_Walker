"""Export a deterministic CityNav RGB clip and frame-indexed scene truth."""
import argparse
import asyncio
import base64
from io import BytesIO
import json
from pathlib import Path

import av
import numpy as np
from PIL import Image
from playwright.async_api import async_playwright

SCRIPT = """
async plan => {
  const [{CityEngine}, {CityRenderer}, {loadCityTextures}] = await Promise.all([
    import('/src/engine.mjs'), import('/src/renderer.mjs'), import('/src/materials.mjs'),
  ]);
  const canvas = document.createElement('canvas');
  const renderer = new CityRenderer(canvas, await loadCityTextures());
  const engine = new CityEngine(plan.config);
  let tick=0;
  const view={yaw:0,pitch:0,zoom:1};
  window.captureEden = target => {
    while (tick<target) engine.advanceSteps(plan.actions[tick++]);
    const camera=renderer.displayCamera(engine,plan.view,null,view,{rawMotion:plan.rawMotion});
    renderer.renderDisplay(engine,camera,{width:1280,height:704,showRobot:plan.view==='chase',showRoute:false});
    return { image:canvas.toDataURL('image/png').split(',')[1], camera,
      signal:engine.snapshot().navigation.signal,
      player:{x:engine.player.x,z:engine.player.z,speed:engine.player.speed},
      actors:engine.actors.filter(a=>Math.hypot(a.x-engine.player.x,a.z-engine.player.z)<=14)
        .map(({id,kind,x,z,speed})=>({id,kind,x,z,speed})) };
  };
}
"""


async def export(args):
    plan = json.loads(args.replay.read_text())
    if args.view:
        plan["view"] = args.view
    plan["rawMotion"] = args.raw_camera
    args.output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(executable_path=args.chromium, args=[
            "--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", *args.chrome_arg,
        ])
        page = await browser.new_page()
        await page.goto(args.url.rstrip("/") + "/src/")
        await page.evaluate(SCRIPT, plan)
        if args.anchor_only:
            first = await page.evaluate("tick=>captureEden(tick)", args.start_tick)
            (args.output / "first-frame.png").write_bytes(base64.b64decode(first["image"]))
            await browser.close()
            return
        frames = []
        with av.open(str(args.output / "recording.mp4"), "w") as out:
            stream = out.add_stream("libx264",rate=24)
            stream.width, stream.height = 1280, 704
            stream.pix_fmt = "yuv420p"
            stream.options = {"crf":"13","preset":"fast"}
            for index in range(args.frames):
                tick = args.start_tick + round(index*20/24)
                if tick > len(plan["actions"]):
                    raise ValueError("Clip exceeds recorded action sequence")
                recorded = await page.evaluate("tick=>captureEden(tick)",tick)
                png = base64.b64decode(recorded.pop("image"))
                if index == 0:
                    (args.output / "first-frame.png").write_bytes(png)
                pixels = np.asarray(Image.open(BytesIO(png)).convert("RGB"))
                for packet in stream.encode(av.VideoFrame.from_ndarray(pixels,format="rgb24")):
                    out.mux(packet)
                frames.append({"frame":index,"tick":tick,**recorded})
            for packet in stream.encode():
                out.mux(packet)
        (args.output / "truth.json").write_text(json.dumps({
            "config":plan["config"],"view":plan["view"],"fps":24,"width":1280,"height":704,"frames":frames,
        },ensure_ascii=False,indent=2)+"\n")
        await browser.close()


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replay",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--url",default="http://127.0.0.1:8765")
    parser.add_argument("--frames",type=int,default=117)
    parser.add_argument("--start-tick",type=int,default=0)
    parser.add_argument("--view",choices=("robot","chase"))
    parser.add_argument("--raw-camera",action="store_true",help="Include the first-person gait motion for comparison")
    parser.add_argument("--anchor-only",action="store_true")
    parser.add_argument("--chromium")
    parser.add_argument("--chrome-arg",action="append",default=[])
    asyncio.run(export(parser.parse_args()))
