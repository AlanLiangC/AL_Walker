"""Rotate real or passthrough WebRTC sessions, sampling process and GPU health."""
import argparse
import asyncio
import json
import os
from pathlib import Path
import signal
import time
from urllib.request import urlopen

from playwright.async_api import async_playwright

from browser import open_city, summarize

CASES = json.loads(Path(__file__).with_name("cases.json").read_text())


def fetch_health(url):
    with urlopen(url.rstrip("/")+"/eden/health", timeout=5) as response:
        return json.load(response)


async def health_log(args, deadline):
    with (args.output/"telemetry.jsonl").open("w") as file:
        while time.monotonic() < deadline:
            started = time.monotonic()
            entries = {"at": started}
            try:
                entries["service"] = await asyncio.to_thread(fetch_health,args.url)
            except OSError as error:
                entries["error"] = str(error)
            try:
                command = await asyncio.create_subprocess_exec("nvidia-smi",
                    "--query-gpu=uuid,memory.used,utilization.gpu,temperature.gpu,power.draw",
                    "--format=csv,noheader,nounits",stdout=asyncio.subprocess.PIPE)
                stdout, _ = await command.communicate()
                entries["gpus"] = stdout.decode().splitlines()
            except OSError:
                pass
            file.write(json.dumps(entries)+"\n")
            file.flush()
            await asyncio.sleep(min(5,max(0,deadline-time.monotonic())))


async def rotate(browser, args, index, deadline):
    page = await browser.new_page(viewport={"width":960,"height":640})
    await open_city(page,args.url,replay=True)
    data = []
    try:
        for cycle in range(len(CASES)*1000):
            if time.monotonic() >= deadline:
                break
            case = CASES[(index+cycle)%len(CASES)]
            await page.locator(f"[data-view={case['view']}]").click()
            await page.evaluate("""({episodeId,cycle,index})=>{
                edenLog.length=0;
                CityNav.policy.reset({episodeId,seed:1500+cycle*11+index});
                window.rotateTimer=setInterval(()=>{
                  CityNav.policy.step({throttle:0.12,turn:Math.sin(CityNav.snapshot().time)*0.35});
                },50);
            }""", {**case,"cycle":cycle,"index":index})
            await page.locator("[data-eden=compare]").click()
            started = await page.evaluate("performance.now()")
            await asyncio.sleep(min(args.rotation,max(0,deadline-time.monotonic())))
            stopped = await page.evaluate("clearInterval(rotateTimer); performance.now()")
            await page.locator("[data-eden=original]").click()
            events = await page.evaluate("edenLog")
            rollup = summarize(events,interval=(started,stopped))
            origins = dict()
            for event in events:
                if event["type"]!="present":
                    continue
                session = origins.setdefault(event["sessionId"], {"frames":0,"epochs":set()})
                session["frames"]+=1
                session["epochs"].add(event["epoch"])
            for session in origins.values():
                session["epochs"] = sorted(session["epochs"])
            data.append({"cycle":cycle,"episodeId":case["episodeId"],"summary":rollup,"sessions":origins})
            (args.output / f"lane-{index}.json").write_text(json.dumps(data,indent=2))
    finally:
        await page.close()
    return data


async def crash(args, deadline):
    while time.monotonic()+5 < deadline:
        await asyncio.sleep(3)
        health = await asyncio.to_thread(fetch_health,args.url)
        workers = health["workers"]
        live = [w for w in workers if w["busy"] and w["ready"] and w["info"]]
        if len(live) != args.lanes:
            continue
        await asyncio.sleep(10)
        victim = live[-1]
        pid = victim["info"]["pid"]
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
        if b"multiprocessing.spawn" not in cmdline:
            raise RuntimeError("Test worker PID no longer matches its spawn command")
        os.kill(pid,signal.SIGKILL)
        begun = time.monotonic()
        evidence = {"pid":pid,"gpu":victim["gpu"],"reason":"test-worker-sigkill","at":begun}
        path = args.output / "injected.json"
        path.write_text(json.dumps(evidence,indent=2))
        while time.monotonic()+3 < deadline:
            await asyncio.sleep(3)
            health = await asyncio.to_thread(fetch_health,args.url)
            recovered = next((w for w in health["workers"] if w["gpu"] == victim["gpu"]), None)
            if recovered and recovered["ready"] and recovered["info"]["pid"] != pid:
                evidence.update(replacementPid=recovered["info"]["pid"],recoverySeconds=time.monotonic()-begun)
                path.write_text(json.dumps(evidence,indent=2))
                break
        return


async def capacity_probe(browser, args, deadline):
    while time.monotonic()+10 < deadline:
        await asyncio.sleep(2)
        workers = (await asyncio.to_thread(fetch_health,args.url))["workers"]
        if len(workers)!=4 or not all(w["busy"] for w in workers):
            continue
        page = await browser.new_page(viewport={"width":840,"height":590})
        try:
            await open_city(page,args.url)
            await page.locator("[data-eden=compare]").click()
            await page.wait_for_function("edenLog.some(e=>e.state==='fallback'&&e.reason==='HTTP 503')",timeout=8000)
            return not await page.locator("#eden-output").is_visible()
        except Exception:
            pass
        finally:
            await page.close()
    return False


async def main(args):
    args.output.mkdir(parents=True,exist_ok=True)
    baseline = []
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(executable_path=args.chromium,args=[
            "--no-sandbox","--disable-dev-shm-usage","--enable-unsafe-swiftshader",
            "--disable-backgrounding-occluded-windows","--disable-renderer-backgrounding",*args.chrome_arg,
        ])
        if args.baseline_seconds:
            single_dir = args.output / "single"
            single_dir.mkdir(exist_ok=True)
            single = argparse.Namespace(**vars(args))
            single.output = single_dir
            baseline = await rotate(browser,single,0,time.monotonic()+args.baseline_seconds)
        began = time.monotonic()
        deadline = began+args.seconds
        side = [health_log(args,deadline)]
        if args.lanes==4:
            side.append(capacity_probe(browser,args,deadline))
        if args.inject_worker_exit:
            if not args.url.startswith("http://127.0.0.1:"):
                raise ValueError("Worker process injection requires a local test service")
            side.append(crash(args, deadline))
        outcomes = await asyncio.gather(*side,*(rotate(browser,args,index,deadline) for index in range(args.lanes)))
        await browser.close()
    lanes = outcomes[len(side):]
    unique = [key for lane in lanes for cycle in lane for key in cycle["sessions"]]
    isolated = len(unique) == len(set(unique))
    fault_path = args.output / "injected.json"
    fault = json.loads(fault_path.read_text()) if fault_path.exists() else {}
    checks = {
        "duration":time.monotonic()-began>=args.seconds,
        "sessionIsolation":isolated,
        "allLanesPresented":all(any(cycle["summary"]["rendered"] for cycle in lane) for lane in lanes),
        "fifthClientFallback":outcomes[1] if args.lanes==4 else None,
        "processExitInjected":bool(fault) if args.inject_worker_exit else None,
        "workerReplaced":bool(fault.get("replacementPid")) if args.inject_worker_exit else None,
    }
    metrics = []
    for lane in lanes:
        metrics.append([{"episodeId":cycle["episodeId"], "summary":{
            key:cycle["summary"][key] for key in ("rendered","pairRate","freshFps","availability","firstFrameMs","frameAgeMs")
        }} for cycle in lane])
    (args.output/"stress.json").write_text(json.dumps({
        "seconds":time.monotonic()-began,"targetSeconds":args.seconds,"lanes":args.lanes,
        "checks":checks,"passed":all(v for v in checks.values() if v is not None),"metrics":metrics,
        "singleLaneBaseline":[cycle["summary"] for cycle in baseline],
    },indent=2))


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url",default="http://127.0.0.1:8765")
    parser.add_argument("--chromium")
    parser.add_argument("--chrome-arg",action="append",default=[])
    parser.add_argument("--seconds",type=int,default=1800)
    parser.add_argument("--rotation",type=int,default=60)
    parser.add_argument("--baseline-seconds",type=int,default=35)
    parser.add_argument("--lanes",type=int,choices=range(1,5),default=4)
    parser.add_argument("--inject-worker-exit",action="store_true")
    parser.add_argument("--output",type=Path,required=True)
    asyncio.run(main(parser.parse_args()))
