import json, os, torch
from safetensors.torch import load_file
base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "model")
sd = load_file(base + r"\xiaoxiao.safetensors")
cfg = json.load(open(base + r"\xiaoxiao.json", encoding="utf-8"))
keys = list(sd.keys())
print("keys:", len(keys))
print("first 5:", keys[:5])
print("prefix weight.?", keys[0].startswith("weight."))
if keys[0].startswith("weight."):
    sd = {k[len("weight."):]: v for k, v in sd.items()}
cpt = {"config": cfg["config"], "weight": sd, "f0": cfg.get("f0", 1), "version": cfg.get("version", "v2"), "info": cfg.get("info", "")}
out = base + r"\xiaoxiao.pth"
torch.save(cpt, out)
print("saved:", out, "sr:", cfg["config"][-1], "emb_g:", sd["emb_g.weight"].shape[0])
