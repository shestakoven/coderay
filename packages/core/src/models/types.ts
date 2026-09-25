export type JsonSchema = Record<string, unknown>;

export interface StructuredRequest {
  prompt: string;
  schema: JsonSchema;
}

export interface GenerateOptions {
  signal?: AbortSignal;
}

export interface StructuredModel {
  generate(request: StructuredRequest, options?: GenerateOptions): Promise<unknown>;
}

export type EmbedStatus =
  | { state: 'loading' }
  | { state: 'downloading'; bytes: number }
  | { state: 'ready' }
  | { state: 'unavailable'; reason: string };

export interface EmbedModel {
  readonly id: string;
  status(): EmbedStatus;
  onStatus(listener: (status: EmbedStatus) => void): () => void;
  embed(texts: string[]): Promise<Float32Array[]>;
}

export interface ModelProvider {
  reasoning: StructuredModel;
  fast: StructuredModel;
  embed: EmbedModel;
}
