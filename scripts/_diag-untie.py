"""Test hypothesis: tied embeddings break Ollama's GGUF conversion of qwen2-0.5B.
Re-save the merged model with an explicit (untied) lm_head, no retrain."""
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

SRC = r"C:\Users\allam\projects\star\data\ownmodel\star-brain"
DST = r"C:\Users\allam\projects\star\data\ownmodel\star-brain-untied"

tok = AutoTokenizer.from_pretrained(SRC)
m = AutoModelForCausalLM.from_pretrained(SRC, dtype=torch.float16)
print("tied?", m.config.tie_word_embeddings)
# Materialise an explicit output projection from the (tied) input embeddings.
m.config.tie_word_embeddings = False
m.lm_head.weight = torch.nn.Parameter(m.get_input_embeddings().weight.detach().clone())
m.save_pretrained(DST, safe_serialization=True)
tok.save_pretrained(DST)
print("SAVED_UNTIED", DST)
