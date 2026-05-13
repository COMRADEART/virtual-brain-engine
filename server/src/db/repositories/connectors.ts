import { ulid } from "ulid";
import type {
  ConnectorDescriptor,
  ConnectorKind,
  ConnectorState,
} from "../../../../shared/connector.js";
import { openDb } from "../sqlite.js";
import { isLocalUrl } from "../../util/network.js";

interface ConnectorRow {
  id: string;
  name: string;
  kind: ConnectorKind;
  base_url: string | null;
  model: string | null;
  embedding_model: string | null;
  enabled: number;
  is_default: number;
  state: ConnectorState;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToConnector(row: ConnectorRow): ConnectorDescriptor {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url ?? undefined,
    model: row.model ?? undefined,
    embeddingModel: row.embedding_model ?? undefined,
    enabled: row.enabled === 1,
    isDefault: row.is_default === 1,
    state: row.state,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isLocal: isLocalUrl(row.base_url),
  };
}

export function listConnectors(): ConnectorDescriptor[] {
  const db = openDb();
  const rows = db
    .prepare<[], ConnectorRow>(`SELECT * FROM connectors ORDER BY is_default DESC, created_at ASC`)
    .all();
  return rows.map(rowToConnector);
}

export function getConnector(id: string): ConnectorDescriptor | null {
  const db = openDb();
  const row = db
    .prepare<[string], ConnectorRow>(`SELECT * FROM connectors WHERE id = ?`)
    .get(id);
  return row ? rowToConnector(row) : null;
}

export function getDefaultConnector(): ConnectorDescriptor | null {
  const db = openDb();
  const row = db
    .prepare<[], ConnectorRow>(
      `SELECT * FROM connectors WHERE enabled = 1 ORDER BY is_default DESC, created_at ASC LIMIT 1`,
    )
    .get();
  return row ? rowToConnector(row) : null;
}

export interface ConnectorUpsertInput {
  id?: string;
  name: string;
  kind: ConnectorKind;
  baseUrl?: string;
  model?: string;
  embeddingModel?: string;
  enabled?: boolean;
  isDefault?: boolean;
}

export function upsertConnector(input: ConnectorUpsertInput): ConnectorDescriptor {
  const db = openDb();
  const now = new Date().toISOString();
  const id = input.id ?? ulid();
  const existing = db
    .prepare<[string], ConnectorRow>(`SELECT * FROM connectors WHERE id = ?`)
    .get(id);

  if (existing) {
    db.prepare(
      `UPDATE connectors
         SET name=?, kind=?, base_url=?, model=?, embedding_model=?,
             enabled=?, is_default=?, updated_at=?
       WHERE id=?`,
    ).run(
      input.name,
      input.kind,
      input.baseUrl ?? null,
      input.model ?? null,
      input.embeddingModel ?? null,
      input.enabled === false ? 0 : 1,
      input.isDefault ? 1 : 0,
      now,
      id,
    );
  } else {
    db.prepare(
      `INSERT INTO connectors
         (id, name, kind, base_url, model, embedding_model, enabled, is_default,
          state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'idle', ?, ?)`,
    ).run(
      id,
      input.name,
      input.kind,
      input.baseUrl ?? null,
      input.model ?? null,
      input.embeddingModel ?? null,
      input.enabled === false ? 0 : 1,
      input.isDefault ? 1 : 0,
      now,
      now,
    );
  }

  if (input.isDefault) {
    db.prepare(`UPDATE connectors SET is_default = 0 WHERE id != ?`).run(id);
  }

  const row = db
    .prepare<[string], ConnectorRow>(`SELECT * FROM connectors WHERE id = ?`)
    .get(id);
  if (!row) {
    throw new Error("Failed to upsert connector");
  }
  return rowToConnector(row);
}

export function updateConnectorState(
  id: string,
  state: ConnectorState,
  message?: string | null,
): void {
  const db = openDb();
  db.prepare(
    `UPDATE connectors SET state = ?, last_error = ?, updated_at = ? WHERE id = ?`,
  ).run(state, message ?? null, new Date().toISOString(), id);
}

export function deleteConnector(id: string): void {
  const db = openDb();
  db.prepare(`DELETE FROM connectors WHERE id = ?`).run(id);
}
