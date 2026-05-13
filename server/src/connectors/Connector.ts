import type {
  ConnectorDescriptor,
  ConnectorTestResult,
  SendOptions,
} from "../../../shared/connector.js";

export type ConnectorErrorKind =
  | "unreachable"
  | "not-found"
  | "bad-response"
  | "aborted"
  | "unsupported";

export class ConnectorError extends Error {
  readonly kind: ConnectorErrorKind;
  readonly status?: number;
  constructor(kind: ConnectorErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ConnectorError";
    this.kind = kind;
    this.status = status;
  }
}

export interface Connector {
  readonly descriptor: ConnectorDescriptor;
  listModels(signal?: AbortSignal): Promise<string[]>;
  send(prompt: string, opts?: SendOptions): Promise<string>;
  stream(prompt: string, opts?: SendOptions): AsyncIterable<string>;
  embed?(text: string, signal?: AbortSignal): Promise<number[]>;
  test(signal?: AbortSignal): Promise<ConnectorTestResult>;
}
