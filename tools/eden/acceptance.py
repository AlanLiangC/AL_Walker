"""Collect CityNav validation artifacts without assigning a tier to missing evidence."""
import argparse
import csv
import json
from pathlib import Path


def read(path):
    if path.is_file():
        return json.loads(path.read_text())


def browser_run(path, root):
    data = read(path)
    if data is None or "summary" not in data:
        return None
    summary = {key:value for key,value in data["summary"].items() if key not in {"rtcp","fallback"}}
    summary["fallbackCount"] = len(data["summary"]["fallback"])
    summary["directRtp"] = any(row.get("rtpTimestamp") is not None for row in data["events"] if row["type"]=="present")
    return {key:data[key] for key in ("case","checks","failure","fallbackMs","recoveryMs","end") if key in data} | {
        "summary":summary,"path":str(path.relative_to(root)),
        "backends":sorted({row["backend"] for row in data["events"] if row["type"]=="present"}),
    }


def replays(directory, root):
    return {path.stem:run for path in sorted(directory.glob("*.json")) if (run:=browser_run(path, root))}


def environment(root):
    gpu = root / "gpus.csv"
    hardware = list(csv.DictReader(gpu.open(), skipinitialspace=True)) if gpu.exists() else []
    return {"hardware":hardware,"torchProbe":"torch-probe.txt",
            "sdpa":read(root/"ada-sdpa.json"),"network":"Chromium and service on the same host via loopback"}


def policy(directory, root):
    results = {}
    for mode in ("raw","enhanced","timeout"):
        path = directory / f"policy-{mode}.json"
        if data := read(path):
            results[mode] = {"path":str(path.relative_to(root)),"metrics":data["metrics"],"sources":data["sources"]}
    return results


def main(args):
    root = args.results
    cpu = root/"passthrough"
    gpu = root/"eden"
    benches = {path.stem.removeprefix("benchmark-"):read(path)
               for path in sorted((gpu/"benchmarks").glob("benchmark-*.json"))}
    verified = {}
    for mode in ("standard","extreme"):
        verified[mode] = {robot:read(root/f"benchmark-{mode}-{robot}.txt") for robot in ("go2","b2","g1")}
    source_test = browser_run(cpu/"interactive.json", root)
    native_test = browser_run(gpu/"interactive.json", root)
    native_24 = browser_run(gpu/"preview24"/"interactive.json", root)
    interactive = native_24 or native_test
    native_replays = replays(gpu/"replays", root)
    manual = read(gpu/"semantic-review.json")
    stress = read(gpu/"stress"/"stress.json")
    tier = {
        "transport": bool(source_test and not source_test.get("failure") and all(source_test["checks"].values())),
        "real5BPreview": bool(native_test and "edenlive" in native_test["backends"]),
        "real5BInteractiveAccepted": bool(interactive and interactive["summary"]["meetsInteractiveTargets"]
            and len(native_replays)==6 and all(row["summary"]["meetsInteractiveTargets"] for row in native_replays.values())
            and manual and manual.get("passed") and stress and stress.get("passed")),
    }
    output = {
        "version":1,"pathsRelativeTo":"results","environment":environment(root),"tiers":tier,"offline":read(root/"offline.json"),
        "referenceController":verified,
        "transport":{"interactive":source_test,"replays":replays(cpu/"replays-final", root),
                     "stress":read(cpu/"stress"/"stress.json"),
                     "parityB2":replays(cpu/"replays-b2", root),"parityG1":replays(cpu/"replays-g1", root),
                     "policy":policy(cpu, root)},
        "edenlive":{"benchmarks":benches,"upstreamOffline":read(gpu/"upstream-offline.json"),
                    "interactive":native_test,"preview24":native_24,"replays":native_replays,
                    "probeRechecks":replays(gpu/"probe-rechecks", root),
                    "parityB2":replays(gpu/"parity-b2", root),"parityG1":replays(gpu/"parity-g1", root),
                    "cyclist":replays(gpu/"cyclist", root),"cyclistReview":read(gpu/"cyclist"/"review.json"),
                    "workers":read(gpu/"four-ready.json"),
                    "semanticReview":manual,"stress":stress,"policy":policy(gpu, root)},
    }
    args.output.write_text(json.dumps(output,indent=2,ensure_ascii=False)+"\n")
    print(json.dumps(tier))


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--results",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    main(parser.parse_args())
