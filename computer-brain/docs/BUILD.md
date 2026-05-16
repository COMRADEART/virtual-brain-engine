# Build Instructions

## Rust Core

```powershell
cd computer-brain
cargo check --workspace
```

## Desktop UI

Install frontend dependencies once:

```powershell
cd computer-brain/apps/desktop-pet
npm install
```

Run the web UI:

```powershell
npm run dev
```

Run the Tauri desktop app:

```powershell
npm run tauri:dev
```

## Local Model

Install and run Ollama, then pull a model:

```powershell
ollama pull llama3.1
ollama pull nomic-embed-text
```

Computer Brain defaults to `http://127.0.0.1:11434`.
