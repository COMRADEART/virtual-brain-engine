// "Feed files to the brain" — a drop zone / file picker that reads any file and
// sends its bytes to POST /api/ingest/file. The server extracts readable content
// (text/code directly, HTML/PDF/Office best-effort, images via the perception
// worker's caption) and stores it as searchable memory. Per-file status + the
// honest server note (e.g. a scanned PDF, or an image with the worker offline)
// are shown inline.

import { useRef, useState } from "react";
import { CheckCircle2, FileUp, Loader2, XCircle } from "lucide-react";
import { apiClient } from "../../engine/apiClient";
import { toastError } from "../../engine/toastBus";

// JSON body cap is 40mb server-side; base64 inflates ~33%, so keep the file
// under ~28MB.
const MAX_BYTES = 28 * 1024 * 1024;

interface FileItem {
  id: number;
  name: string;
  status: "pending" | "done" | "error";
  note?: string;
  ingested?: number;
  kind?: string;
}

// FileReader yields a data: URL; strip the "data:...;base64," prefix.
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const res = String(fr.result);
      const comma = res.indexOf(",");
      resolve(comma >= 0 ? res.slice(comma + 1) : res);
    };
    fr.onerror = () => reject(fr.error ?? new Error("read failed"));
    fr.readAsDataURL(file);
  });
}

let nextId = 1;

export function FileIngestSection(): JSX.Element {
  const [items, setItems] = useState<FileItem[]>([]);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function update(id: number, patch: Partial<FileItem>): void {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }

  async function handleFiles(files: FileList | File[]): Promise<void> {
    for (const file of Array.from(files)) {
      const id = nextId++;
      const item: FileItem = { id, name: file.name, status: "pending" };
      setItems((prev) => [item, ...prev].slice(0, 30));
      if (file.size > MAX_BYTES) {
        update(id, { status: "error", note: "too large (max 28MB)" });
        continue;
      }
      try {
        const dataBase64 = await readAsBase64(file);
        const res = await apiClient.ingestFile({ filename: file.name, mimeType: file.type, dataBase64 });
        update(id, {
          status: res.ok ? "done" : "error",
          note: res.note,
          ingested: res.ingest.ingested,
          kind: res.kind,
        });
      } catch (e) {
        update(id, { status: "error", note: e instanceof Error ? e.message : "upload failed" });
        toastError(`Couldn't read ${file.name}`);
      }
    }
  }

  return (
    <section className="shortcuts-section">
      <h3>
        <FileUp size={13} /> Feed files to the brain
      </h3>

      <div
        className={`file-dropzone ${drag ? "drag" : ""}`}
        role="button"
        tabIndex={0}
        aria-label="Add files to memory"
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          if (e.dataTransfer.files.length) void handleFiles(e.dataTransfer.files);
        }}
      >
        <FileUp size={22} aria-hidden="true" />
        <span>Drop files here, or click to browse</span>
        <small>Text, code, PDFs, Word / PowerPoint / Excel, images — any format</small>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) void handleFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {items.length > 0 && (
        <ul className="file-result-list">
          {items.map((it) => (
            <li key={it.id} className={`file-result-item ${it.status}`}>
              <span className="file-result-icon" aria-hidden="true">
                {it.status === "pending" && <Loader2 size={13} className="spin" />}
                {it.status === "done" && <CheckCircle2 size={13} />}
                {it.status === "error" && <XCircle size={13} />}
              </span>
              <span className="file-result-body">
                <span className="file-result-name">{it.name}</span>
                <small className="file-result-note">
                  {it.status === "pending"
                    ? "reading…"
                    : it.status === "done"
                      ? `${it.kind ?? "file"} · ${it.ingested ?? 0} chunk${it.ingested === 1 ? "" : "s"} learned${it.note ? ` · ${it.note}` : ""}`
                      : it.note ?? "failed"}
                </small>
              </span>
            </li>
          ))}
        </ul>
      )}

      <p className="settings-note">
        Files are read locally and stored as searchable memory. Images are described by the perception worker (start it under
        <code> worker/</code> to read images).
      </p>
    </section>
  );
}
