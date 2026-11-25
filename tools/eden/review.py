"""Summarize human annotations on exact paired CityNav and EdenLive frames."""
import argparse
from collections import Counter
import json
from pathlib import Path

CASES = json.loads(Path(__file__).with_name("cases.json").read_text())
ISSUES = ("addedActor","missingActor","signalColor","drift","occlusion","weather","unreadable")


def summarize(cases_dir, annotations):
    report = {}
    totals = Counter({key:0 for key in ISSUES})
    for case in CASES:
        key = case["episodeId"]
        file = cases_dir / f"{key}.json"
        available = {}
        if file.is_file():
            fields = json.loads(file.read_text()).get("reviewStills", [])
            available = {frame["file"]:frame for frame in fields if frame["backend"]=="edenlive"}
        observations = annotations.get(key, [])
        readable = Counter()
        findings = Counter({kind:0 for kind in ISSUES})
        reviewed = []
        for observation in observations:
            frame = available.get(observation["file"])
            if frame is None:
                raise ValueError(f"Missing matched frame {observation['file']}")
            readable.update(observation.get("readable", {}))
            for issue in observation.get("findings", []):
                if issue["kind"] not in ISSUES:
                    raise ValueError(f"Unknown issue type {issue['kind']}")
                findings[issue["kind"]] += 1
            reviewed.append({"simTick":frame["simTick"],"outputId":frame["outputId"],
                             "sessionId":frame["sessionId"],**observation})
        totals.update(findings)
        has_critical = any(issue.get("critical",False) for row in reviewed for issue in row.get("findings",[]))
        report[key] = {"availableStills":len(available),"reviewedStills":len(reviewed),"readable":dict(readable),
                       "counts":dict(findings),"criticalFailure":has_critical,"observations":reviewed}
    return {"passed":all(item["reviewedStills"]>0 and not item["criticalFailure"] and not item["counts"]["unreadable"]
                         for item in report.values()),"cases":report,"totals":dict(totals)}


if __name__=="__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--replays",type=Path,required=True)
    parser.add_argument("--annotations",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True)
    args = parser.parse_args()
    result = summarize(args.replays,json.loads(args.annotations.read_text()))
    args.output.write_text(json.dumps(result,indent=2,ensure_ascii=False)+"\n")
    print(json.dumps({"passed":result["passed"],"totals":result["totals"]},ensure_ascii=False))
