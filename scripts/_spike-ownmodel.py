"""De-risking spike for the brain's own-model pipeline (Learning Lab Phase D).

Proves the two architectural risks BEFORE relying on them:
  1. The LoRA continued-pretraining loop runs on THIS machine's GPU with the
     chosen base (Qwen2.5-0.5B) and produces a merged HF safetensors dir.
  2. That merged dir imports into the installed Ollama (0.30.6) and answers.

Tiny corpus + few steps — quality is irrelevant here; this only proves the path.
Throwaway: writes to data/ownmodel/star-brain-spike and creates an Ollama model
'star-brain-spike' the runner removes afterward.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
WORKER = os.path.join(HERE, "..", "worker")
sys.path.insert(0, os.path.abspath(WORKER))

OUT = os.path.abspath(os.path.join(HERE, "..", "data", "ownmodel"))
os.environ["OWN_MODEL_OUT"] = OUT
os.environ["OWN_MODEL_NAME"] = "star-brain-spike"

from finetune.trainer import default_status, run_finetune  # noqa: E402

# A small but real-ish corpus so tokenization + blocks behave like production.
corpus = (
    "The brain prefers truth over agreement. Evidence beats assumptions. "
    "STAR is a local-first personal brain that reasons over its own memories. "
    "It surfaces confidence and explains itself. Retrieval is the knowledge path; "
    "the own-model adapts voice and domain. "
) * 60

status = default_status()
print("[spike] starting LoRA CPT — base Qwen/Qwen2.5-0.5B, 15 steps", flush=True)
run_finetune(corpus, status, steps=15, base_model="Qwen/Qwen2.5-0.5B")
print("[spike] final state:", status["state"], flush=True)
print("[spike] device:", status["device"], "trainableParams:", status["trainableParams"], flush=True)
print("[spike] loss:", status["loss"], "outputDir:", status["outputDir"], flush=True)
print("[spike] message:", status["message"], flush=True)

if status["state"] != "done" or not status["outputDir"]:
    print("SPIKE_TRAIN_FAILED", flush=True)
    sys.exit(1)
print("SPIKE_TRAIN_OK", flush=True)
