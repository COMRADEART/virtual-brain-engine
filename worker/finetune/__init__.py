"""The brain's OWN model (Learning Lab — Phase D: own-LLM).

Where Phase C (`train/`) builds a tiny GPT *from scratch* on the personal corpus
(educational; learns texture, can't answer), this phase produces a model the
brain can actually REASON with: a **LoRA continued-pretraining** pass over a
small open base model (default Qwen2.5-0.5B), merged and served through Ollama
as an opt-in connector.

Honest scope — read this before overclaiming:

  * This adapts the base model's VOICE and DOMAIN to your memories (and bakes in
    a few light facts). It does NOT replace retrieval: RAG is still the brain's
    knowledge path and does facts better. "The brain's own voice", not "the
    brain's own knowledge".
  * Why continued-pretraining and not instruction SFT? A personal brain has
    thousands of memory chunks but only a handful of real conversation pairs.
    SFT on a dozen pairs overfits and DEGRADES the base model; continued
    pretraining on the corpus is the honest objective for the data we have.
  * The one outbound action is the base-model download from Hugging Face on the
    first run — deliberate, user-initiated setup (same category as pulling an
    Ollama model), not the server reaching out on its own.

torch / transformers / peft are imported LAZILY by the caller (worker/main.py)
inside the /ownmodel/* handlers, so the bare worker still boots without ML deps
— exactly like the perception models and the from-scratch trainer.
"""
