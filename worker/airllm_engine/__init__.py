"""AirLLM high-parameter inference + distillation for the worker sidecar.

NOTE the package name: it is deliberately NOT `airllm` — the worker runs with
`worker/` on sys.path, so a local package named `airllm` would SHADOW the pip
`airllm` package and `from airllm import AutoModel` would resolve to this dir
instead. `airllm_engine` keeps the two cleanly separated.
"""
