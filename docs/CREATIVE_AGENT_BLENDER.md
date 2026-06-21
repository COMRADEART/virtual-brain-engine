# Creative agent — "give it an objective, it does it through a real tool" (Blender)

This is the worked example of the capstone: you hand the brain an objective and a
reference image (e.g. *"3D-model a character from this image like a pro"*) and the
agent loop drives **Blender** over many rounds — seeing its own viewport between
steps and refining — through the existing permissioned trust boundary.

Nothing here is new privilege. Blender tools are reached as **MCP tools**, which
register as **confirm-tier dynamic actions** and run only through `executeAction`
(allowlist + zod + confirm/scope gate + audit), exactly like every other effector.

## What it adds (all flag-gated, default OFF)

| Piece | Flag | Default | Effect |
|-------|------|---------|--------|
| Reference image → task context | *(none — providing an image is the opt-in)* | — | Each image is captioned by the perception worker and injected into the loop's prompt. |
| Visual feedback loop | `CREATIVE_AGENT` | OFF | Image results from a tool (a Blender viewport screenshot) are captioned + pinned to `data/artifacts/` so the model **sees** its work between rounds. |
| Creative protocol | `CREATIVE_AGENT` | OFF | A "block out → refine → material → light → export, and *capture & inspect* each pass" protocol block is injected. |
| Long-horizon budget | `AGENT_CREATIVE_MAX_ROUNDS` (or per-request `maxRounds`) | 36 | Creative tasks get a much higher round ceiling than the default `AGENT_MAX_ROUNDS` (12); paced down by the energy budget if that's on. |
| Blender MCP server | `MCP_ENABLED` + `MCP_SERVERS` | OFF | The `blender` preset (stdio `uvx blender-mcp`) — gated by `ALLOW_SHELL`. |

## One-time setup

1. **Blender + the MCP addon.** Install [Blender](https://www.blender.org/) and the
   [`blender-mcp`](https://github.com/ahujasid/blender-mcp) addon (`addon.py`):
   Blender → Edit → Preferences → Add-ons → Install, enable **"Blender MCP"**, then
   in the 3D viewport sidebar (N) open the **BlenderMCP** tab and click
   **"Connect to MCP server"** (starts its socket server).
2. **`uv`** (provides `uvx`): `pip install uv` (or see the uv docs). `uvx blender-mcp`
   is what the brain spawns.
3. **Perception worker** (for vision/captioning): start the Python worker
   (`worker/`) with the ML deps so `/caption` is available. Without it the loop
   still runs and pins screenshots, but can't *describe* them (honest note).
4. **Env** (root `.env`):
   ```
   MCP_ENABLED=true
   ALLOW_SHELL=true            # stdio MCP servers spawn a process
   CREATIVE_AGENT=true
   MCP_SERVERS=[{"id":"blender","transport":"stdio","command":"uvx","args":["blender-mcp"],"enabled":true,"risk":"confirm"}]
   ```
   `LOCAL_ONLY` can stay `true` — a stdio server is local; nothing leaves the machine.

## Use it

`POST /api/agent` (the desktop pet's command box is the UI):
```jsonc
{
  "prompt": "Model a low-poly character from this reference, like a pro 3D artist.",
  "referenceImages": [{ "base64": "<png-bytes-base64>", "mime": "image/png" }],
  "confirmMode": "scope",
  "scope": { "allow": ["safe", "confirm"] },   // approve the Blender tools for the run
  "maxRounds": 40
}
```
The loop will: caption the reference → call Blender tools to block out / refine →
`get_viewport_screenshot` → read the caption of what it made → adjust → repeat →
export, reporting the artifact path. Every tool call is audited; in `ask` mode each
is approved individually instead of via a run scope.

## Acceptance (runtime check — not a hermetic gate)

With Blender + addon running and the env above set, a single objective + reference
image drives multi-round Blender tool calls, captions each viewport back into its
reasoning, and produces a `.blend`/render artifact under `data/artifacts/`. Re-running
a similar objective later surfaces the learned procedure (procedural memory).

The hermetic pieces (image extraction, artifact pinning, worker-down degradation,
round budget) are covered by `npm run agent:selfcheck`; the live Blender path is the
runtime check above.
