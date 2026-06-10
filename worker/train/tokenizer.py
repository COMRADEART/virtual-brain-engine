"""Char-level tokenizer — the smallest honest vocab for a personal corpus.

Deterministic: the vocab is the sorted set of unique characters in the corpus,
so encode/decode round-trip exactly and a given corpus always yields the same
ids. No external deps (no torch, no tiktoken) — importable anywhere Python is.
"""
from __future__ import annotations


class CharTokenizer:
    def __init__(self, corpus: str) -> None:
        # Sorted for determinism; index 0 is the lexicographically-first char.
        chars = sorted(set(corpus))
        if not chars:
            raise ValueError("cannot build a tokenizer from an empty corpus")
        self.itos: dict[int, str] = {i: c for i, c in enumerate(chars)}
        self.stoi: dict[str, int] = {c: i for i, c in enumerate(chars)}
        self.vocab_size: int = len(chars)

    def encode(self, text: str) -> list[int]:
        # Unknown chars (shouldn't happen for the training corpus, but can for
        # a sampling prompt) are skipped rather than crashing.
        return [self.stoi[c] for c in text if c in self.stoi]

    def decode(self, ids: list[int]) -> str:
        return "".join(self.itos.get(i, "") for i in ids)
