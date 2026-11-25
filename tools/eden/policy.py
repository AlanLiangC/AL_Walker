"""Run the same RGB test strategy with native RGB, matched video and timeout."""
import argparse
import asyncio
import json
from collections import Counter
from pathlib import Path

from playwright.async_api import async_playwright

JS = Path(__file__).with_name("policy.mjs")


async def evaluate(args):
    async with async_playwright() as driver:
        browser = await driver.chromium.launch(executable_path=args.chromium, args=[
            "--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-swiftshader",
            "--autoplay-policy=no-user-gesture-required", *args.chrome_arg,
        ])
        for mode in ["raw", "enhanced", "timeout"]:
            page = await browser.new_page(viewport={"width": 1100, "height": 720})
            await page.goto(args.url.rstrip("/") + "/src/")
            await page.wait_for_function("!!window.CityNav", timeout=30_000)
            text = JS.read_text().replace("export async function", "async function", 1)
            await page.add_script_tag(content=text)
            result = await page.evaluate("config=>sensorTrial(config)", {
                "endpoint": args.url.rstrip("/") + "/eden",
                "episodeId": args.episode, "seed": args.seed, "mode": mode,
                "steps": args.steps, "timeoutMs": 550 if mode == "timeout" else args.timeout,
            })
            timeline = result["timeline"]
            buckets = Counter(row["used"] for row in timeline)
            assert any(row["before"] != row["after"] and row["action"]["turn"] != 0 for row in timeline)
            assert all(row["sampleTick"] <= row["decisionTick"] for row in timeline)
            assert all(row["frame"]["eventSample"] == row["sampleId"] and row["frame"]["simTick"] == row["sampleTick"]
                       for row in timeline if row.get("frame"))
            result["sources"] = dict(buckets)
            result["metrics"] = {
                "success": result["final"]["status"] == "success",
                "score": result["final"]["score"],
                "terminal": result["final"]["status"],
                "collisions": sum(row["code"]=="collision" for row in result["final"]["events"]),
                "violations": dict(Counter(row["code"] for row in result["final"]["events"])),
            }
            args.output.mkdir(parents=True, exist_ok=True)
            (args.output / f"policy-{mode}.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))
            print(json.dumps({"mode": mode, "sources": result["sources"], "metrics": result["metrics"]}), flush=True)
            await page.close()
        await browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://127.0.0.1:8765")
    parser.add_argument("--chromium")
    parser.add_argument("--chrome-arg", action="append", default=[])
    parser.add_argument("--episode", default="boulevard-01-e02")
    parser.add_argument("--seed", type=int, default=1983246877)
    parser.add_argument("--steps", type=int, default=8)
    parser.add_argument("--timeout", type=int, default=16_000)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(evaluate(parser.parse_args()))
