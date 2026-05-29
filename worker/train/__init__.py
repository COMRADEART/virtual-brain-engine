"""From-scratch LLM trainer (Learning Lab — Phase C).

A faithful-but-honest port of FareedKhan-dev/train-llm-from-scratch: the same
GPT architecture (token + position embeddings, stacked causal-attention +
MLP blocks, layer norm, residuals, AdamW with a cosine LR schedule, cross
-entropy), trained from ZERO on the brain's OWN memory corpus instead of The
Pile.

Two deliberate departures from the source repo, both because the corpus is a
personal brain's memories (kilobytes–megabytes, not 825GB):

  * Char-level tokenizer instead of tiktoken. A 50k BPE vocab over a tiny
    corpus is almost all dead embeddings; char-level keeps the model honest
    and small.
  * Tiny defaults (~0.x M params, CPU-friendly). This trains in seconds-to
    -minutes and produces text with the corpus's *texture*, not a capable
    assistant. That limitation is the point, not a bug.

torch is imported lazily by the caller (worker/main.py) INSIDE the /train/*
handlers so the worker still boots without ML deps — exactly like the
perception models.
"""
