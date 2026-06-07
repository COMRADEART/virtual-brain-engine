"""Deep compare: full KV key sets + sample tensor values/dtype between GGUFs."""
import numpy as np
from gguf import GGUFReader

A = GGUFReader(r"data/ownmodel/star-brain-bf16/model.gguf")        # llama.cpp (works)
B = GGUFReader(r"data/ownmodel/star-brain-bf16/model-mine2.gguf")  # mine (empty)

ka = set(A.fields.keys())
kb = set(B.fields.keys())
print("KV only in LLAMACPP:", sorted(ka - kb))
print("KV only in MINE    :", sorted(kb - ka))

# sample tensor compare
ta = {t.name: t for t in A.tensors}
tb = {t.name: t for t in B.tensors}
print("tensor count A/B:", len(ta), len(tb))
print("tensors only in A:", sorted(set(ta) - set(tb))[:8])
print("tensors only in B:", sorted(set(tb) - set(ta))[:8])
for name in ["token_embd.weight", "output_norm.weight", "blk.0.attn_q.weight", "blk.0.attn_q.bias"]:
    if name in ta and name in tb:
        a = np.array(ta[name].data, dtype=np.float32).ravel()[:5]
        b = np.array(tb[name].data, dtype=np.float32).ravel()[:5]
        print(f"{name}\n  A({ta[name].tensor_type.name}): {a}\n  B({tb[name].tensor_type.name}): {b}")
