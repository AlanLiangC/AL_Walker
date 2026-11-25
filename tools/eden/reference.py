"""Freeze route-free opening frames and their camera metadata for local reference use."""
import argparse
import asyncio
import base64
import hashlib
import json
from pathlib import Path

from playwright.async_api import async_playwright

from browser import open_city, live



async def capture(args):
    args.output.mkdir(parents=True,exist_ok=True)
    cases = [json.loads(p.read_text()) for p in sorted(args.replays.glob("*.json"))]
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(executable_path=args.chromium, args=[
            "--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader",*args.chrome_arg,
        ])
        for case in cases:
            page = await browser.new_page()
            await open_city(page,args.url,replay=True)
            await page.locator(f"[data-view={case['view']}]").click()
            await page.evaluate("config=>CityNav.policy.reset(config)",case["config"])
            await page.locator("[data-eden=compare]").click()
            await live(page)
            data=await page.evaluate("""() => {
              const meta=edenLog.find(e=>e.type==='present');
              return { meta,seed:CityNav.snapshot().seed,weather:edenLog.findLast(e=>e.state==='warming').weather,
                img:document.querySelector('#eden-draft').toDataURL() };
            }""")
            meta = data["meta"]
            if meta["simTick"] != 0 or meta["backend"] != "passthrough":
                raise ValueError("Reference capture requires the passthrough profile and tick zero")
            episode=case["episodeId"]
            weather=data["weather"]
            name=f"{episode}-{data['seed']}-{case['view']}-{weather}"
            pixels=base64.b64decode(data["img"].split(",")[1])
            (args.output / (name + ".png")).write_bytes(pixels)
            desc={"episodeId":episode,"seed":data["seed"],"view":case["view"],"weather":weather,
                "camera":meta["input"]["camera"],"simTick":0,
                "sha256":hashlib.sha256(pixels).hexdigest(),
                "source":"AL_Walker CityRenderer, route-free CityNav procedural scene, passthrough H.264/VP8",
                "appearance":"source"}
            (args.output / (name + ".json")).write_text(json.dumps(desc,indent=2))
            await page.close()
            print(name,flush=True)
        await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url",default="http://127.0.0.1:8765")
    parser.add_argument("--replays",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--chromium")
    parser.add_argument("--chrome-arg",action="append",default=[])
    asyncio.run(capture(parser.parse_args()))
