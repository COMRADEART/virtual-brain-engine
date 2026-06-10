"""Self-contained HF(Qwen2) -> GGUF exporter for the brain's own model.

Why this exists: `ollama create FROM <hf-safetensors-dir>` mis-imports what
transformers 5.x's save_pretrained writes (emits a model that decodes a single
repeated token). The robust path is to hand Ollama a ready GGUF. Rather than
depend on a runtime clone of llama.cpp's multi-module converter, this writes the
GGUF ourselves with the `gguf` pip package — faithful to llama.cpp's qwen2
tensor map + gpt2-BPE vocab handling, scoped to exactly the architecture our
trainer produces (Qwen2/Qwen2.5 decoder, the default base).

Only depends on `gguf` (+ numpy/torch/transformers already present). Not a
general converter — it asserts the arch is qwen2 and refuses otherwise, so a
future base-model change fails loudly instead of writing a silently-wrong file.
"""
from __future__ import annotations

import json
import os
from typing import Any

import numpy as np
import torch
from gguf import GGUFWriter, TokenType
from transformers import AutoModelForCausalLM, AutoTokenizer


def _load_config(model_dir: str) -> dict[str, Any]:
    with open(os.path.join(model_dir, "config.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def _gpt2_vocab(model_dir: str, vocab_size: int) -> tuple[list[str], list[int], list[str]]:
    """Replicate llama.cpp's _set_vocab_gpt2: byte-level token strings as-is,
    merges from tokenizer.json, special tokens flagged CONTROL."""
    tok = AutoTokenizer.from_pretrained(model_dir)
    base_vocab: dict[str, int] = tok.get_vocab()  # token-string -> id (byte-level unicode)
    reverse = {i: t for t, i in base_vocab.items()}
    special_ids = set(tok.all_special_ids)
    # added_tokens (incl. <|im_start|> etc.) are CONTROL even if not in all_special_ids
    added_ids = {int(i) for i in getattr(tok, "added_tokens_decoder", {}).keys()}

    tokens: list[str] = []
    toktypes: list[int] = []
    for i in range(vocab_size):
        if i not in reverse:
            tokens.append(f"[PAD{i}]")
            toktypes.append(int(TokenType.UNUSED))
            continue
        tokens.append(reverse[i])
        toktypes.append(
            int(TokenType.CONTROL) if (i in special_ids or i in added_ids) else int(TokenType.NORMAL)
        )

    # Merges from tokenizer.json (Qwen stores them as "a b" strings or [a,b] pairs).
    merges: list[str] = []
    tj_path = os.path.join(model_dir, "tokenizer.json")
    if os.path.exists(tj_path):
        with open(tj_path, "r", encoding="utf-8") as f:
            tj = json.load(f)
        raw_merges = tj.get("model", {}).get("merges", [])
        for m in raw_merges:
            merges.append(m if isinstance(m, str) else " ".join(m))
    return tokens, toktypes, merges


# HF tensor name -> GGUF tensor name (per layer suffixes filled in below).
def _export(model_dir: str, out_path: str) -> str:
    cfg = _load_config(model_dir)
    arch = (cfg.get("architectures") or ["?"])[0].lower()
    model_type = cfg.get("model_type", "")
    if "qwen2" not in model_type and "qwen2" not in arch:
        raise ValueError(
            f"gguf_export only supports qwen2 (got model_type={model_type!r} arch={arch!r}). "
            "Use llama.cpp's converter for other architectures."
        )

    n_layer = cfg["num_hidden_layers"]
    n_head = cfg["num_attention_heads"]
    n_kv = cfg.get("num_key_value_heads", n_head)
    n_embd = cfg["hidden_size"]
    n_ff = cfg["intermediate_size"]
    vocab_size = cfg["vocab_size"]
    rope_theta = float(cfg.get("rope_theta", 1_000_000.0))
    rms_eps = float(cfg.get("rms_norm_eps", 1e-6))
    ctx_len = int(cfg.get("max_position_embeddings", 32768))
    tie = bool(cfg.get("tie_word_embeddings", False))

    model = AutoModelForCausalLM.from_pretrained(model_dir, dtype=torch.float16)
    sd = model.state_dict()

    def t(name: str, f32: bool = False) -> np.ndarray:
        # llama.cpp keeps norms + biases in F32 even in an F16 model (tiny but
        # precision-sensitive); only the big weight matrices are F16. Matching
        # that exactly — an all-F16 model loads but decodes to nothing.
        dt = torch.float32 if f32 else torch.float16
        return sd[name].to(dt).cpu().numpy()

    writer = GGUFWriter(out_path, arch="qwen2")
    writer.add_name(os.path.basename(os.path.normpath(model_dir)))
    writer.add_context_length(ctx_len)
    writer.add_embedding_length(n_embd)
    writer.add_block_count(n_layer)
    writer.add_feed_forward_length(n_ff)
    writer.add_head_count(n_head)
    writer.add_head_count_kv(n_kv)
    writer.add_rope_freq_base(rope_theta)
    writer.add_layer_norm_rms_eps(rms_eps)
    writer.add_file_type(1)  # MOSTLY_F16

    # --- tokenizer ---
    tokens, toktypes, merges = _gpt2_vocab(model_dir, vocab_size)
    writer.add_tokenizer_model("gpt2")
    writer.add_tokenizer_pre("qwen2")
    writer.add_token_list(tokens)
    writer.add_token_types(toktypes)
    writer.add_token_merges(merges)
    def _tok_id(key: str, default: int) -> int:
        v = cfg.get(key)  # key may be present but null (Qwen base has bos_token_id: null)
        return int(v) if v is not None else default

    eos = _tok_id("eos_token_id", 151643)
    writer.add_eos_token_id(eos)
    writer.add_bos_token_id(_tok_id("bos_token_id", eos))
    writer.add_pad_token_id(_tok_id("pad_token_id", eos))

    # Chat template — Qwen ships one even on base models; Ollama uses it to frame
    # prompts. Omitting it leaves Ollama with a raw passthrough that yields no
    # output. Read from tokenizer_config.json.
    tcfg_path = os.path.join(model_dir, "tokenizer_config.json")
    if os.path.exists(tcfg_path):
        with open(tcfg_path, "r", encoding="utf-8") as f:
            tcfg = json.load(f)
        ct = tcfg.get("chat_template")
        if isinstance(ct, str) and ct:
            writer.add_chat_template(ct)

    # --- tensors ---
    writer.add_tensor("token_embd.weight", t("model.embed_tokens.weight"))
    writer.add_tensor("output_norm.weight", t("model.norm.weight", f32=True))
    # When embeddings are tied, llama.cpp expects NO separate output.weight — it
    # reuses token_embd. Writing a redundant copy yields a model that loads but
    # decodes to nothing. Only emit output.weight for an untied head.
    if not tie and "lm_head.weight" in sd:
        writer.add_tensor("output.weight", t("lm_head.weight"))

    for i in range(n_layer):
        p = f"model.layers.{i}."
        b = f"blk.{i}."
        writer.add_tensor(b + "attn_norm.weight", t(p + "input_layernorm.weight", f32=True))
        writer.add_tensor(b + "attn_q.weight", t(p + "self_attn.q_proj.weight"))
        writer.add_tensor(b + "attn_q.bias", t(p + "self_attn.q_proj.bias", f32=True))
        writer.add_tensor(b + "attn_k.weight", t(p + "self_attn.k_proj.weight"))
        writer.add_tensor(b + "attn_k.bias", t(p + "self_attn.k_proj.bias", f32=True))
        writer.add_tensor(b + "attn_v.weight", t(p + "self_attn.v_proj.weight"))
        writer.add_tensor(b + "attn_v.bias", t(p + "self_attn.v_proj.bias", f32=True))
        writer.add_tensor(b + "attn_output.weight", t(p + "self_attn.o_proj.weight"))
        writer.add_tensor(b + "ffn_norm.weight", t(p + "post_attention_layernorm.weight", f32=True))
        writer.add_tensor(b + "ffn_gate.weight", t(p + "mlp.gate_proj.weight"))
        writer.add_tensor(b + "ffn_up.weight", t(p + "mlp.up_proj.weight"))
        writer.add_tensor(b + "ffn_down.weight", t(p + "mlp.down_proj.weight"))

    writer.write_header_to_file()
    writer.write_kv_data_to_file()
    writer.write_tensors_to_file()
    writer.close()
    return out_path


def export_gguf(model_dir: str, out_path: str | None = None) -> str:
    """Export the HF model at `model_dir` to a GGUF file. Returns the GGUF path."""
    out = out_path or os.path.join(model_dir, "model.gguf")
    return _export(model_dir, out)


if __name__ == "__main__":  # pragma: no cover
    import sys

    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else None
    print("GGUF written:", export_gguf(src, dst))
