"""Diagnose the merged own-model: is it NaN/broken, and does it generate?"""
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

D = r"C:\Users\allam\projects\star\data\ownmodel\star-brain"
tok = AutoTokenizer.from_pretrained(D)
m = AutoModelForCausalLM.from_pretrained(D, dtype=torch.float32)
nan = sum(int(torch.isnan(p).any()) for p in m.parameters())
print("params_with_nan:", nan)
ids = tok("STAR is", return_tensors="pt").input_ids
out = m.generate(ids, max_new_tokens=30, do_sample=False)
print("GEN:", repr(tok.decode(out[0], skip_special_tokens=True)))
