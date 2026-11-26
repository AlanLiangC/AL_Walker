"""Export a deterministic CityNav RGB clip and frame-indexed scene truth."""
import argparse
import asyncio
import base64
from contextlib import ExitStack
from io import BytesIO
import json
from pathlib import Path

import av
import numpy as np
from PIL import Image
from playwright.async_api import async_playwright

SCRIPT = """
async plan => {
  const [{CityEngine}, {CityRenderer}, {loadCityTextures}, {semanticControl}] = await Promise.all([
    import('/src/engine.mjs'), import('/src/renderer.mjs'), import('/src/materials.mjs'), import('/src/render-layout.mjs'),
  ]);
  const canvas = document.createElement('canvas');
  const renderer = new CityRenderer(canvas, await loadCityTextures());
  if (plan.detailed) await renderer.loadDetailedActors(location.href);
  const engine = new CityEngine(plan.config);
  let tick=0;
  const view={yaw:0,pitch:0,zoom:1};
  window.captureEden = target => {
    while (tick<target) engine.advanceSteps(plan.actions[tick++]);
    const camera=renderer.displayCamera(engine,plan.view,null,view,{rawMotion:plan.rawMotion});
    const {width,height}=plan,showRobot=plan.view==='chase';
    renderer.renderDisplay(engine,camera,{width,height,showRobot,showRoute:false,detailed:plan.detailed});
    const image=canvas.toDataURL('image/png').split(',')[1];
    const depth=plan.depth?renderer.photoGeometry(engine,camera,width/height,{staticOnly:false,detailed:plan.detailed,showRobot}):null;
    let layout;
    if (plan.layouts) {
      layout={labels:semanticControl(renderer,engine,camera,{width,height,detailed:plan.detailed,showRobot}),
        calibration:renderer.cameraCalibration(camera,width,height),
        actors:engine.actors.map(({id,kind,x,y,z,yaw,speed})=>({id,kind,x,y,z,yaw,speed}))};
    }
    return { image, ...(depth?{depth:{width:depth.width,height:depth.height,pixels:Array.from(depth.pixels)}}:{}), camera, layout,
      signal:engine.snapshot().navigation.signal,
      player:{x:engine.player.x,z:engine.player.z,speed:engine.player.speed},
      actors:engine.actors.filter(a=>Math.hypot(a.x-engine.player.x,a.z-engine.player.z)<=14)
        .map(({id,kind,x,z,speed})=>({id,kind,x,z,speed})) };
  };
  return plan.layouts?(engine.world.layout??null):null;
}
"""


async def export(args):
    plan = json.loads(args.replay.read_text())
    if args.view:
        plan["view"] = args.view
    plan["rawMotion"] = args.raw_camera
    depth_enabled = args.depth or args.layouts
    plan.update(width=args.width, height=args.height, depth=depth_enabled, detailed=args.detailed, layouts=args.layouts)
    args.output.mkdir(parents=True, exist_ok=True)
    if args.layouts:
        for name in ("rgb", "labels", "depth-mm"):
            (args.output / name).mkdir(exist_ok=True)
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(executable_path=args.chromium, args=[
            "--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader", *args.chrome_arg,
        ])
        page = await browser.new_page()
        await page.goto(args.url.rstrip("/") + "/src/")
        scene_layout = await page.evaluate(SCRIPT, plan)
        if args.layouts and scene_layout is not None:
            (args.output / "scene.json").write_text(json.dumps(scene_layout, ensure_ascii=False, indent=2) + "\n")
        if args.anchor_only:
            first = await page.evaluate("tick=>captureEden(tick)", args.start_tick)
            (args.output / "first-frame.png").write_bytes(base64.b64decode(first["image"]))
            await browser.close()
            return
        frames = []
        with ExitStack() as files:
            sinks = {}
            for name in ("recording", "depth") if depth_enabled else ("recording",):
                out = files.enter_context(av.open(str(args.output / f"{name}.mp4"), "w"))
                stream = out.add_stream("libx264", rate=24)
                stream.width, stream.height = args.width, args.height
                stream.pix_fmt = "yuv420p"
                stream.options = {"crf":"13","preset":"fast"}
                sinks[name] = (out, stream)
            for index in range(args.frames):
                tick = args.start_tick + round(index*20/24)
                if tick > len(plan["actions"]):
                    raise ValueError("Clip exceeds recorded action sequence")
                recorded = await page.evaluate("tick=>captureEden(tick)",tick)
                png = base64.b64decode(recorded.pop("image"))
                layout = recorded.pop("layout", None)
                if index == 0:
                    (args.output / "first-frame.png").write_bytes(png)
                images = {"recording": np.asarray(Image.open(BytesIO(png)).convert("RGB"))}
                if depth_enabled:
                    payload = recorded.pop("depth")
                    rgba = np.array(payload["pixels"], np.uint32).reshape(payload["height"], payload["width"], 4)[::-1]
                    metres = (rgba[..., 0] + rgba[..., 1]*256 + rgba[..., 2]*65536) * .001
                    # Depth controls use white for nearby surfaces and black for the horizon.
                    inverse = np.where(metres > 0, .65 / np.maximum(metres, .65), 0)
                    gray = Image.fromarray((np.sqrt(inverse)*255).astype(np.uint8)).resize(
                        (args.width, args.height), Image.Resampling.NEAREST).convert("RGB")
                    images["depth"] = np.asarray(gray)
                    if layout:
                        filename = f"{index:06}.png"
                        recorded["calibration"] = layout["calibration"]
                        recorded["actors"] = layout["actors"]
                        (args.output / "rgb" / filename).write_bytes(png)
                        with Image.open(BytesIO(base64.b64decode(layout["labels"]))) as labels:
                            labels.getchannel("R").save(args.output / "labels" / filename)
                        Image.fromarray(rgba[..., :3].astype(np.uint8)).save(args.output / "depth-mm" / filename)
                for name, pixels in images.items():
                    out, stream = sinks[name]
                    for packet in stream.encode(av.VideoFrame.from_ndarray(pixels, format="rgb24")):
                        out.mux(packet)
                frames.append({"frame":index,"tick":tick,**recorded})
            for out, stream in sinks.values():
                for packet in stream.encode():
                    out.mux(packet)
        (args.output / "truth.json").write_text(json.dumps({
            "config":plan["config"],"view":plan["view"],"fps":24,"width":args.width,"height":args.height,"frames":frames,
            **({"labels":"Cityscapes labelIds", "depth":"packed little-endian RGB millimetres; 0 = no surface"} if args.layouts else {}),
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
    parser.add_argument("--width",type=int,default=1280)
    parser.add_argument("--height",type=int,default=704)
    parser.add_argument("--depth",action="store_true",help="Export aligned CityNav depth with dynamic traffic included")
    parser.add_argument("--layouts",action="store_true",help="Save aligned RGB, Cityscapes label IDs, metric depth and camera calibration")
    parser.add_argument("--detailed",action="store_true",help="Use the detailed traffic meshes in the control clips")
    parser.add_argument("--anchor-only",action="store_true")
    parser.add_argument("--chromium")
    parser.add_argument("--chrome-arg",action="append",default=[])
    asyncio.run(export(parser.parse_args()))
