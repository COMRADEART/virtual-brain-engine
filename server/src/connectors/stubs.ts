import type {
  ConnectorDescriptor,
  ConnectorTestResult,
  SendOptions,
} from "../../../shared/connector.js";
import { Connector, ConnectorError } from "./Connector.js";

// Phase-3 placeholders. The registry instantiates them so the polymorphism
// works, but every call throws so attempts to use them surface clearly.

abstract class StubConnector implements Connector {
  readonly descriptor: ConnectorDescriptor;
  constructor(descriptor: ConnectorDescriptor) {
    this.descriptor = descriptor;
  }
  protected fail(method: string): never {
    throw new ConnectorError("unsupported", `${this.descriptor.kind}:${method} not implemented`);
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  listModels(_signal?: AbortSignal): Promise<string[]> {
    return Promise.resolve([]);
  }
  send(_prompt: string, _opts?: SendOptions): Promise<string> {
    return Promise.reject(this.makeError("send"));
  }
  // eslint-disable-next-line require-yield
  async *stream(_prompt: string, _opts?: SendOptions): AsyncIterable<string> {
    throw this.makeError("stream");
  }
  test(): Promise<ConnectorTestResult> {
    return Promise.resolve({
      ok: false,
      message: `${this.descriptor.kind} connector is a placeholder (Phase 3).`,
    });
  }
  private makeError(method: string): ConnectorError {
    return new ConnectorError(
      "unsupported",
      `${this.descriptor.kind}:${method} not implemented`,
    );
  }
}

export class HuggingFaceConnector extends StubConnector {}
export class PythonScriptConnector extends StubConnector {}
export class AgentConnector extends StubConnector {}
