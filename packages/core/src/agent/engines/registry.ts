import type { EngineCapabilities, EngineId, EngineStatus, ModelInfo } from '@ide/protocol';
import type { StructuredModel } from '../../models/types';
import type { AgentTransport, Launch, TransportSink } from '../transport';

/** A background model on an engine, and its id in `ModelInfo.value` form. */
export interface BackgroundModel {
  modelId: string;
  model: StructuredModel;
}

/** One agent CLI a chat can run on. */
export interface Engine {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  status(): Promise<EngineStatus>;
  listModels(): Promise<ModelInfo[]>;
  start(launch: Launch, sink: TransportSink): AgentTransport;
  /**
   * The model a background call runs on: the engine's choice for null, else that model; null when the engine has none such;
   * a sentence for a person when this install of the engine runs no background call at all (its version is not verified for it).
   */
  background(model: string | null): Promise<BackgroundModel | string | null>;
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
