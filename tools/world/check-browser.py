"""Exercise style entry, keyboard control, and an external reference session."""
import argparse
import asyncio
import base64
import json
from pathlib import Path
import time

from playwright.async_api import async_playwright


async def check(args):
    args.output.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle",
                                                "--use-angle=vulkan", "--disable-vulkan-surface"])
        page = await browser.new_page(viewport={"width": 1400, "height": 920})
        page.on("pageerror", lambda error: print(error, flush=True))
        await page.add_init_script("""
          window.renderedFrames=[];
          addEventListener('citynav-eden',e=>{
            if (e.detail.type==='photo-present') renderedFrames.push(e.detail);
          });
        """)
        path = "/src/?eden=/eden&episode=office-09-x05&view=robot&edenDiagnostics=1"
        if args.method not in ("cosmos", "edge-turbo", "sharp"):
            path += "&renderBench=1"
        await page.goto(args.url + path + ("&edenCompare=1" if args.parallel else ""))
        await page.locator("[data-eden=photo]").click(timeout=30_000)
        method = page.locator("#photo-method")
        if args.method == "cosmos":
            methods = await method.locator("option").evaluate_all("options=>options.map(option=>option.value)")
            assert "cosmos" in methods and set(methods) <= {"eden-stream", "cosmos", "regen", "edge-turbo", "sharp"}
        if await method.input_value() != args.method:
            await method.select_option(args.method)
        generate = page.locator("#reference-start")
        styles = page.get_by_label("场景风格", exact=True)
        prompt = page.get_by_label("场景风格提示词")
        assert await styles.locator("option").count() == 11
        assert not await generate.is_enabled()
        await prompt.fill("自定义纪实街景，柔和的自然光")
        await styles.select_option("golden-hour")
        assert "Warm low sunlight" in await prompt.input_value()
        await styles.select_option("")
        assert await prompt.input_value() == "自定义纪实街景，柔和的自然光"
        await styles.select_option("after-rain")
        await prompt.fill(await prompt.input_value() + " Preserve clear pavement edges.")
        assert await styles.input_value() == ""
        expected_style = await prompt.input_value()
        start = time.monotonic()
        async with page.expect_request(lambda request: request.url.endswith("/world/start")) as opening:
            await generate.click()
        assert (await opening.value).post_data_json["style"] == expected_style
        await page.wait_for_function("renderedFrames.at(-1)?.simTick===0", timeout=480_000)
        if args.parallel:
            assert await page.locator("#viewport").get_attribute("data-eden-parallel") is not None
        opening_ms = (time.monotonic() - start) * 1000
        print(f"Opening reference displayed after {opening_ms:.0f} ms", flush=True)
        finish_keyboard = asyncio.Event()
        if args.keyboard_only:
            submitted = False

            async def one_action(route):
                nonlocal submitted
                if submitted:
                    await finish_keyboard.wait()
                    await route.abort()
                else:
                    submitted = True
                    await route.continue_()

            await page.route("**/world/frame", one_action)
        await page.locator("#run").click()
        await page.keyboard.down("w")
        minimum_tick = 2 if args.keyboard_only else 4
        await page.wait_for_function("(tick)=>renderedFrames.at(-1)?.simTick>=tick", arg=minimum_tick,
                                     timeout=650_000 if args.keyboard_only else 1_300_000)
        await page.keyboard.up("w")
        if not args.keyboard_only:
            await page.keyboard.press("Escape")
            await page.wait_for_function("document.querySelector('#viewport').hasAttribute('data-eden-live')",
                                         timeout=120_000)
        await page.screenshot(path=args.output / "keyboard.png")
        keyboard = await page.evaluate("({traveled:CityNav.snapshot().traveled,frames:renderedFrames})")
        keyboard["openingMs"] = opening_ms
        assert keyboard["traveled"] > 0 and all(x["method"] == args.method for x in keyboard["frames"])
        if args.keyboard_only:
            (args.output / "results.json").write_text(json.dumps({"keyboard": keyboard}, indent=2) + "\n")
            finish_keyboard.set()
            await browser.close()
            print(f"Verified keyboard reference-conditioned steps with {args.method}")
            return
        external = await page.evaluate("""async method=>{
          CityNav.policy.reset({episodeId:'boulevard-01-e02',robotId:'go2'});
          const style='A candid European street photography scene at golden hour. Warm sun and long shadows, realistic '
            +'vehicles and pedestrians, natural colors, dry asphalt, realistic stone texture.';
          const frames=[await CityNav.rendered.start(method==='cosmos'?{style}:{style,method})];
          const probe=document.createElement('canvas');
          probe.width=8;
          probe.height=8;
          const context=probe.getContext('2d',{willReadFrequently:true});
          for(let step=0;step<2;step++){
            const previous=frames.at(-1);
            const image=await createImageBitmap(previous.image);
            context.drawImage(image,0,0,8,8);
            image.close();
            const pixels=context.getImageData(0,4,8,4).data;
            let left=0,right=0;
            for(let i=0;i<pixels.length;i+=4){
              const brightness=pixels[i]+pixels[i+1]+pixels[i+2];
              if(i%32<16) left+=brightness;
              else right+=brightness;
            }
            const action={throttle:.5,turn:right>=left?.2:-.2};
            previous.action=action;
            frames.push(await CityNav.rendered.step(action,{observationId:previous.observationId,ticks:2}));
          }
          const asBase64=blob=>new Promise(resolve=>{
            const reader=new FileReader();
            reader.onload=()=>resolve(reader.result.split(',')[1]);
            reader.readAsDataURL(blob);
          });
          return Promise.all(frames.map(async frame=>({method:frame.method,tick:frame.simTick,
            reference:frame.referenceSha256,session:frame.sessionId,observationId:frame.observationId,
            observationTick:Math.round(frame.observation.time*20),action:frame.action,
            renderMs:frame.renderMs,image:await asBase64(frame.image)})));
        }""", args.method)
        assert [x["tick"] for x in external] == [0, 2, 4]
        assert all(x["tick"] == x["observationTick"] and x["method"] == args.method for x in external)
        assert len({x["reference"] for x in external}) == len({x["session"] for x in external}) == 1
        assert len({x["image"] for x in external}) == 3
        for item in external:
            (args.output / f"external-{item['tick']:02d}.png").write_bytes(base64.b64decode(item.pop("image")))
        (args.output / "results.json").write_text(json.dumps({"keyboard": keyboard, "external": external}, indent=2))
        await browser.close()
        print(f"Verified keyboard and external reference-conditioned steps with {args.method}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8771")
    parser.add_argument("--method", default="cosmos")
    parser.add_argument("--keyboard-only", action="store_true", help="verify one rendered CityNav keyboard step")
    parser.add_argument("--parallel", action="store_true", help="check that the original renderer stays visible")
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(check(parser.parse_args()))
