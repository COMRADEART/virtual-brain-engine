// One-shot CLI to kick off a scan and stream progress to stdout.
// Requires the server to be running (`npm run dev:server`).

const BASE = process.env.BRAIN_API_URL ?? "http://127.0.0.1:8787";

async function main() {
  // Use Node 22+ built-in WebSocket
  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/brain`);

  let done = false;
  ws.addEventListener("open", async () => {
    const res = await fetch(`${BASE}/api/scan/run`, { method: "POST" });
    if (!res.ok) {
      console.error(`scan trigger failed: ${res.status}`);
      ws.close();
      process.exit(1);
    }
    console.log("scan started; streaming progress…");
  });
  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === "scan") {
        const pct = data.total > 0 ? Math.round((data.processed / data.total) * 100) : 0;
        process.stdout.write(`\r[${pct}%] ${data.processed}/${data.total} ${(data.current ?? "").slice(-60)}        `);
        if (data.done) {
          console.log("\nscan complete.");
          done = true;
          ws.close();
        }
      }
    } catch {
      // ignore
    }
  });
  ws.addEventListener("close", () => {
    if (!done) {
      console.warn("\nws closed before scan finished.");
    }
    process.exit(done ? 0 : 1);
  });
  ws.addEventListener("error", (err) => {
    console.error("ws error:", err);
    process.exit(1);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
