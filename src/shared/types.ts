export interface TranslateRequest {
  text: string;
  sourceLang: string;
  targetLang: string;
  context?: string;
}

export interface TranslateResult {
  translated: string;
  provider: string;
  cached: boolean;
  tokensUsed?: number;
}

export interface ProviderConfig {
  id: string;
  type: 'relay' | 'openai-compat' | 'ollama' | 'openai' | 'lmstudio' | 'deepl' | 'google' | 'custom';
  name: string;
  enabled: boolean;
  baseUrl: string;
  /** Draft-only UI field. Persisted settings and runtime responses never contain this value. */
  apiKey?: string;
  model?: string;
  systemPrompt?: string;
  /** LLM providers only. Default true — skip chain-of-thought for faster translation. */
  disableThinking?: boolean;
  protocol?: RelayProtocol;
  temperature?: number;
  timeoutMs?: number;
  maxConcurrency?: number;
  maxCharsPerRequest?: number;
  /** 0 means no per-batch item cap; character limit still applies. */
  maxItemsPerRequest?: number;
  maxPageChars?: number;
  maxPageRequests?: number;
  retryGatewayErrors?: boolean;
}

export type RelayProtocol = 'chat-completions' | 'responses';

export interface ConnectionTestResult {
  reachable: boolean;
  authenticated: boolean;
  modelAvailable: boolean | null;
  formatCompatible: boolean;
  httpStatus: number | null;
  message: string;
  sample?: string;
}

export interface ModelListResult {
  models: string[];
  httpStatus: number;
}

export interface TranslationItem {
  id: string;
  text: string;
}

export type BatchStatus =
  | 'queued'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'interrupted/unknown'
  | 'cancelled';

export interface TranslationBatchRequest {
  taskId: string;
  sessionId: string;
  batchId: string;
  requestId: string;
  sourceLang: string;
  targetLang: string;
  items: TranslationItem[];
  manualRetryUnknown?: boolean;
  manualRetryFailed?: boolean;
}

export interface BatchItemResult {
  id: string;
  status: Exclude<BatchStatus, 'queued' | 'dispatched'>;
  translated?: string;
  error?: string;
}

export interface TranslationBatchResult {
  taskId: string;
  batchId: string;
  requestId: string;
  status: Exclude<BatchStatus, 'queued' | 'dispatched'>;
  items: BatchItemResult[];
  attempts: number;
  requestsUsed: number;
  charsUsed: number;
}

export type TaskControlAction = 'pause' | 'resume' | 'cancel' | 'restore' | 'complete';

export type ChunkingMode = 'quality' | 'speed';

export type SelectionTriggerMode = 'icon' | 'instant' | 'modifier' | 'off';
export type SelectionModifierKey = 'ctrl' | 'alt' | 'shift';
export type SecretStorageMode = 'session' | 'local' | 'persistent';

export interface AppSettings {
  defaultProvider: string;
  /** Ordered provider IDs to try when the default provider fails. May be empty. */
  fallbackProviders: string[];
  defaultTargetLang: string;
  defaultSourceLang: string;
  providers: ProviderConfig[];
  promptTemplate?: string;
  chunkingMode: ChunkingMode;
  selectionTriggerMode: SelectionTriggerMode;
  selectionModifierKey: SelectionModifierKey;
  keyStorageMode: SecretStorageMode;
}

export interface SecretStatus {
  hasKey: boolean;
  storageMode: SecretStorageMode;
  localKeyStorageAvailable: boolean;
  persistentKeyStorageAvailable: boolean;
  maskedKey?: string;
}

export interface RuntimeSettingsPatch {
  selectionTriggerMode?: SelectionTriggerMode;
  selectionModifierKey?: SelectionModifierKey;
}

export type MessageType =
  | { type: 'TRANSLATE'; payload: TranslateRequest }
  | { type: 'VERIFY_CONFIG'; payload: { providerConfig: ProviderConfig } }
  | { type: 'GET_SETTINGS' }
  | { type: 'GET_SECRET_STATUS' }
  | { type: 'GET_MODELS' }
  | { type: 'TEST_CONNECTION' }
  | { type: 'TRANSLATE_BATCH'; payload: TranslationBatchRequest }
  | { type: 'TASK_CONTROL'; payload: { taskId: string; sessionId: string; action: TaskControlAction } }
  | { type: 'GET_TASK_RECOVERY'; payload: { taskId: string; sessionId: string } }
  | { type: 'SAVE_SETTINGS'; payload: Partial<AppSettings> }
  | { type: 'UPDATE_RUNTIME_SETTINGS'; payload: RuntimeSettingsPatch }
  | { type: 'CLEAR_SECRET' }
  | { type: 'PROBE_CONTENT_SCRIPT_ISOLATION'; payload: { tabId: number } }
  | { type: 'GET_BATCH_DIAGNOSTICS' }
  | { type: 'SET_BATCH_DIAGNOSTICS_ENABLED'; payload: { enabled: boolean } }
  | { type: 'CLEAR_BATCH_DIAGNOSTICS' };

export type MessageResponse<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string };
