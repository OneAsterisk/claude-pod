import json, sys, glob, os
# Sum token usage across a Claude Code session transcript and its subagent transcripts.
# Dedupes by message id (streamed assistant messages are written as several lines sharing one id).
PRICE = {"input": 10.0, "output": 50.0, "cache_read": 0.25, "cache_write": 20.0}  # $/MTok for claude-fable-5-1, 1h cache TTL. Update per run from the current rate card.
def load(path):
    per_msg = {}
    models = set()
    with open(path) as f:
        for line in f:
            try: d = json.loads(line)
            except Exception: continue
            if d.get("type") != "assistant": continue
            m = d.get("message", {})
            u = m.get("usage")
            if not u: continue
            mid = m.get("id") or d.get("requestId") or d.get("uuid")
            models.add(m.get("model"))
            prev = per_msg.get(mid, {})
            per_msg[mid] = {
                "input": max(prev.get("input",0), u.get("input_tokens",0)),
                "output": max(prev.get("output",0), u.get("output_tokens",0)),
                "cache_write": max(prev.get("cache_write",0), u.get("cache_creation_input_tokens",0)),
                "cache_read": max(prev.get("cache_read",0), u.get("cache_read_input_tokens",0)),
            }
    tot = {k: sum(v[k] for v in per_msg.values()) for k in ("input","output","cache_write","cache_read")}
    tot["requests"] = len(per_msg)
    tot["models"] = sorted(x for x in models if x)
    return tot
main = sys.argv[1]
files = [main] + sorted(glob.glob(os.path.join(os.path.dirname(main), os.path.basename(main)[:-6], "subagents", "*.jsonl")))
grand = {"input":0,"output":0,"cache_write":0,"cache_read":0,"requests":0}
rows = []
for p in files:
    t = load(p); rows.append((os.path.basename(p), t))
    for k in grand: grand[k] += t[k]
cost = (grand["input"]*PRICE["input"] + grand["output"]*PRICE["output"] + grand["cache_read"]*PRICE["cache_read"] + grand["cache_write"]*PRICE["cache_write"])/1e6
for name,t in rows:
    print(f'{name[:40]:40} req={t["requests"]:4} in={t["input"]:>8} out={t["output"]:>8} cw={t["cache_write"]:>9} cr={t["cache_read"]:>10} models={t["models"]}')
print("TOTAL", json.dumps(grand), f"total_tokens={sum(grand[k] for k in ('input','output','cache_write','cache_read'))}", f"cost_usd={cost:.2f}")
