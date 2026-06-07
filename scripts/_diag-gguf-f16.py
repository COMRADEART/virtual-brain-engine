"""Both F16 now: compare llama.cpp's working GGUF vs mine tensor-for-tensor + KV."""
import numpy as np
from gguf import GGUFReader

A = GGUFReader(r"data/ownmodel/star-brain-bf16/model-f16.gguf")     # llama.cpp F16 (works)
B = GGUFReader(r"data/ownmodel/star-brain-bf16/model-mine2.gguf")   # mine F16 (empty)

print("KV only in LLAMACPP:", sorted(set(A.fields) - set(B.fields)))
print("KV only in MINE    :", sorted(set(B.fields) - set(A.fields)))

ta = {t.name: t for t in A.tensors}
tb = {t.name: t for t in B.tensors}
print("counts:", len(ta), len(tb))
mism = []
for name in ta:
    if name not in tb:
        mism.append((name, "missing-in-B")); continue
    a = np.array(ta[name].data); b = np.array(tb[name].data)
    if a.shape != b.shape:
        mism.append((name, f"shape {a.shape} vs {b.shape}")); continue
    af = a.astype(np.float32); bf = b.astype(np.float32)
    d = float(np.max(np.abs(af - bf))) if af.size else 0.0
    dt = (ta[name].tensor_type.name, tb[name].tensor_type.name)
    if d > 1e-3 or dt[0] != dt[1]:
        mism.append((name, f"maxdiff={d:.4g} dtype={dt}"))
print("MISMATCH count:", len(mism))
for m in mism[:20]:
    print("  ", m)
