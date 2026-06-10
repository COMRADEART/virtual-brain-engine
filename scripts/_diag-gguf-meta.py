"""Compare tokenizer/meta KV between llama.cpp's GGUF and mine."""
from gguf import GGUFReader

for label, path in [
    ("LLAMACPP", r"data/ownmodel/star-brain-bf16/model.gguf"),
    ("MINE", r"data/ownmodel/star-brain-bf16/model-mine.gguf"),
]:
    r = GGUFReader(path)
    f = r.fields
    def g(k):
        return f.get(k)
    def n(k):
        v = f.get(k)
        return len(v.data) if v is not None else None
    print(f"--- {label} ---")
    for k in [
        "tokenizer.ggml.model",
        "tokenizer.ggml.pre",
        "tokenizer.ggml.bos_token_id",
        "tokenizer.ggml.eos_token_id",
        "tokenizer.ggml.padding_token_id",
        "qwen2.embedding_length",
        "qwen2.block_count",
        "qwen2.attention.head_count_kv",
    ]:
        v = f.get(k)
        if v is None:
            print(f"  {k}: <MISSING>")
            continue
        try:
            print(f"  {k}: {v.contents()}")
        except Exception:
            print(f"  {k}: <present>")
    # counts
    for k in ["tokenizer.ggml.tokens", "tokenizer.ggml.merges", "tokenizer.ggml.token_type"]:
        v = f.get(k)
        print(f"  {k}: count={len(v.data) if v is not None else 'MISSING'}")
