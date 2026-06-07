"""Confirm Qwen2 fp16 overflow + fix by re-saving merged model as bf16."""
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

SRC = r"C:\Users\allam\projects\star\data\ownmodel\star-brain"
DST = r"C:\Users\allam\projects\star\data\ownmodel\star-brain-bf16"

tok = AutoTokenizer.from_pretrained(SRC)
ids = tok("STAR is", return_tensors="pt").input_ids

# Diagnostic: does fp16 inference of the stored weights itself break?
m16 = AutoModelForCausalLM.from_pretrained(SRC, dtype=torch.float16)
g16 = tok.decode(m16.generate(ids, max_new_tokens=20, do_sample=False)[0], skip_special_tokens=True)
print("FP16_GEN:", repr(g16))

# Fix: re-save in bf16 (Qwen2's native dtype — no overflow, GGUF-supported).
m = AutoModelForCausalLM.from_pretrained(SRC, dtype=torch.float32).to(torch.bfloat16)
g = tok.decode(m.generate(ids, max_new_tokens=20, do_sample=False)[0], skip_special_tokens=True)
print("BF16_GEN:", repr(g))
m.save_pretrained(DST, safe_serialization=True)
tok.save_pretrained(DST)
print("SAVED_BF16", DST)
