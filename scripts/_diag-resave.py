"""Isolate: does transformers-5.10 save_pretrained itself produce a model Ollama
can't import? Re-save STOCK Qwen2.5-0.5B (no finetune) and we ollama-create it."""
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

DST = r"C:\Users\allam\projects\star\data\ownmodel\qwen-resave-test"
tok = AutoTokenizer.from_pretrained("Qwen/Qwen2.5-0.5B")
m = AutoModelForCausalLM.from_pretrained("Qwen/Qwen2.5-0.5B", dtype=torch.bfloat16)
m.save_pretrained(DST, safe_serialization=True)
tok.save_pretrained(DST)
print("RESAVED", DST)
