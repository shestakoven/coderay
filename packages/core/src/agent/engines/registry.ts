import type { EngineCapabilities, EngineId, EngineStatus, ModelInfo } from '@ide/protocol';
import type { AgentTransport, Launch, TransportSink } from '../transport';

/** One agent CLI a chat can run on. */
export interface Engine {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  status(): Promise<EngineStatus>;
  listModels(): Promise<ModelInfo[]>;
  start(launch: Launch, sink: TransportSink): AgentTransport;
}

export class EngineRegistry {
  private readonly engines: ReadonlyMap<EngineId, Engine>;

  constructor(engines: Engine[]) {
    this.engines = new Map(engines.map((engine) => [engine.id, engine]));
  }

  get(id: EngineId): Engine | undefined {
    return this.engines.get(id);
  }

  all(): Engine[] {
    return [...this.engines.values()];
  }
}
