import { ProviderManager } from '../providers/manager';
import { getCached, setCache, clearCache as clearTranslationCache, getCacheStats } from './cache';
import type {
  AppSettings,
  ConnectionTestResult,
  ModelListResult,
  ProviderConfig,
  TranslateRequest,
  MessageResponse,
  TranslateResult,
  TranslationBatchRequest,
  TranslationBatchResult,
} from '../shared/types';
import { DEFAULT_SETTINGS, PRIVATE_RELAY_PROVIDER_ID } from '../shared/constants';
import { clearApiKey, clearOtherApiKeys, getApiKey, getSecretStatus, writeApiKey } from './secret-store';
import { canUsePersistentKeyStorage } from './credential-idb';
import { normalizeSecretStorageMode } from './secret-policy';
import { canUseLocalKeyStorage } from './storage-access';
import { validateBaseUrl } from '../shared/url-policy';
import { publicCredentialIsolationProbe } from '../shared/credential-isolation';
import {
  isOptionsSender,
  isOwnExtensionSender,
  isTranslateRequest,
  type RuntimeSenderLike,
} from './message-policy';
import { RelayAdapter } from '../providers/relay';
import { TranslationScheduler } from './scheduler';
import { getTaskJournal } from './task-journal';

const providerManager = new ProviderManager();
const translationScheduler = new TranslationScheduler();
const diagnosticLocks = new Map<string, Promise<unknown>>();

function singleFlight<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const active = diagnosticLocks.get(key);
  if (active) return active as Promise<T>;
  const promise = operation().finally(() => diagnosticLocks.delete(key));
  diagnosticLocks.set(key, promise);
  return promise;
}

export async function handleTabRemoved(tabId: number): Promise<void> {
  await translationScheduler.cancelTab(tabId);
}

function stripSecrets(config: ProviderConfig): ProviderConfig {
  const { apiKey: _apiKey, ...publicConfig } = config;
  return publicConfig;
}

function normalizeSettings(settings: AppSettings): AppSettings {
  const configuredRelay = settings.providers?.find(
    (provider) => provider.id === PRIVATE_RELAY_PROVIDER_ID
      && (provider.type === 'relay' || provider.type === 'openai-compat'),
  );
  const relay = stripSecrets({
    ...DEFAULT_SETTINGS.providers[0],
    ...(configuredRelay ?? {}),
  } as ProviderConfig);
  return {
    ...settings,
    defaultProvider: PRIVATE_RELAY_PROVIDER_ID,
    fallbackProviders: [],
    providers: [{ ...relay, id: PRIVATE_RELAY_PROVIDER_ID, type: 'relay', enabled: true }],
    keyStorageMode: normalizeSecretStorageMode(settings.keyStorageMode, {
      local: canUseLocalKeyStorage(),
      persistent: canUsePersistentKeyStorage(),
    }),
  };
}

function translationConfigFingerprint(settings: AppSettings): string {
  const relay = settings.providers[0];
  return JSON.stringify({
    baseUrl: relay?.baseUrl ?? '',
    model: relay?.model ?? '',
    protocol: relay?.protocol ?? 'chat-completions',
    temperature: relay?.temperature ?? 0.2,
    promptTemplate: settings.promptTemplate ?? '',
  });
}

export async function getSettings(): Promise<AppSettings> {
  const result = await browser.storage.local.get('settings');
  if (!result.settings) return DEFAULT_SETTINGS;
  const raw = { ...DEFAULT_SETTINGS, ...(result.settings as AppSettings) };
  const legacyKey = raw.providers?.find((provider) => provider.apiKey)?.apiKey;
  const normalized = normalizeSettings(raw);
  if (legacyKey) {
    await writeApiKey(legacyKey, normalized.keyStorageMode);
    await browser.storage.local.set({ settings: normalized });
    await clearOtherApiKeys(normalized.keyStorageMode);
  } else if (raw.keyStorageMode === 'local' && normalized.keyStorageMode !== 'local') {
    await browser.storage.local.set({ settings: normalized });
  }
  return normalized;
}

export async function saveSettings(partial: Partial<AppSettings>): Promise<AppSettings> {
  if (partial.keyStorageMode === 'local' && !canUseLocalKeyStorage()) {
    throw new Error('LOCAL_KEY_STORAGE_UNAVAILABLE');
  }
  if (partial.keyStorageMode === 'persistent' && !canUsePersistentKeyStorage()) {
    throw new Error('PERSISTENT_KEY_STORAGE_UNAVAILABLE');
  }
  const current = await getSettings();
  const previousTranslationConfig = translationConfigFingerprint(current);
  const draftKey = partial.providers?.find((provider) => provider.apiKey)?.apiKey;
  const existingKey = current.keyStorageMode !== partial.keyStorageMode
    ? await getApiKey(current.keyStorageMode)
    : '';
  const updated = { ...current, ...partial };
  if (partial.providers) updated.providers = partial.providers;
  const normalized = normalizeSettings(updated);
  const relay = normalized.providers[0];
  if (relay.name.length < 1 || relay.name.length > 80) throw new Error('PROVIDER_NAME_INVALID');
  if (relay.baseUrl) relay.baseUrl = validateBaseUrl(relay.baseUrl).baseUrl;
  if ((relay.model?.length ?? 0) > 200) throw new Error('MODEL_NAME_TOO_LONG');
  if ((normalized.promptTemplate?.length ?? 0) > 12_000) throw new Error('PROMPT_TOO_LONG');
  relay.timeoutMs = Math.min(120_000, Math.max(5_000, relay.timeoutMs ?? 25_000));
  relay.maxConcurrency = Math.min(4, Math.max(1, relay.maxConcurrency ?? 2));
  relay.maxCharsPerRequest = Math.min(20_000, Math.max(500, relay.maxCharsPerRequest ?? 8_000));
  relay.maxPageChars = Math.min(1_000_000, Math.max(1_000, relay.maxPageChars ?? 100_000));
  relay.maxPageRequests = Math.min(1_000, Math.max(1, relay.maxPageRequests ?? 100));
  const nextKey = draftKey?.trim() || existingKey;
  if (nextKey) await writeApiKey(nextKey, normalized.keyStorageMode);
  await browser.storage.local.set({ settings: normalized });
  if (nextKey) await clearOtherApiKeys(normalized.keyStorageMode);
  if (previousTranslationConfig !== translationConfigFingerprint(normalized) || Boolean(draftKey?.trim())) {
    await clearTranslationCache();
  }
  providerManager.clearCache();
  return normalized;
}

function getEnabledProvider(settings: AppSettings, id: string): ProviderConfig | undefined {
  return settings.providers.find((p) => p.id === id && p.enabled);
}

function buildProviderChain(settings: AppSettings): ProviderConfig[] {
  const chain: ProviderConfig[] = [];
  const seen = new Set<string>();

  const defaultConfig = getEnabledProvider(settings, settings.defaultProvider);
  if (defaultConfig) {
    chain.push(defaultConfig);
    seen.add(defaultConfig.id);
  }

  for (const id of settings.fallbackProviders ?? []) {
    if (seen.has(id)) continue;
    const config = getEnabledProvider(settings, id);
    if (config) {
      chain.push(config);
      seen.add(config.id);
    }
  }

  return chain;
}

async function translateWithProvider(
  request: TranslateRequest,
  providerConfig: ProviderConfig,
  promptTemplate?: string,
): Promise<TranslateResult> {
  const cached = await getCached(
    request.text, request.sourceLang, request.targetLang, providerConfig.id,
  );
  if (cached) return cached;

  let config = providerConfig;
  if (promptTemplate && !config.systemPrompt) {
    config = { ...config, systemPrompt: promptTemplate };
  }

  config = { ...config, apiKey: await getApiKey((await getSettings()).keyStorageMode) };
  const provider = providerManager.getProvider(config, { useCache: false });
  const result = await provider.translate(request);

  await setCache(request.text, request.sourceLang, request.targetLang, config.id, result);

  return result;
}

export async function handleTranslate(
  request: TranslateRequest,
): Promise<MessageResponse<TranslateResult>> {
  const settings = await getSettings();
  const chain = buildProviderChain(settings);

  if (chain.length === 0) {
    return { success: false, error: 'NO_PROVIDER' };
  }

  let lastError = '';

  for (const providerConfig of chain) {
    try {
      const result = await translateWithProvider(request, providerConfig, settings.promptTemplate);
      return { success: true, data: result };
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'TRANSLATION_FAILED';
    }
  }

  return { success: false, error: lastError };
}

export async function handleVerifyConfig(
  providerConfig: ProviderConfig,
): Promise<MessageResponse<string>> {
  try {
    if (providerConfig.id !== PRIVATE_RELAY_PROVIDER_ID || providerConfig.type !== 'relay') {
      return { success: false, error: 'RELAY_PROVIDER_REQUIRED' };
    }
    validateBaseUrl(providerConfig.baseUrl);
    const settings = await getSettings();
    const apiKey = providerConfig.apiKey?.trim() || await getApiKey(settings.keyStorageMode);
    const provider = providerManager.getProvider({ ...providerConfig, apiKey }, { useCache: false });
    const result = await provider.translate({
      text: 'Hello',
      sourceLang: 'en',
      targetLang: 'zh',
    });
    if (!result.translated.trim()) {
      return { success: false, error: 'Provider returned empty translation' };
    }
    return { success: true, data: result.translated };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Verification failed' };
  }
}

async function configuredRelay(): Promise<RelayAdapter> {
  const settings = await getSettings();
  const config = settings.providers[0];
  return providerManager.getProvider({
    ...config,
    apiKey: await getApiKey(settings.keyStorageMode),
  }, { useCache: false }) as RelayAdapter;
}

async function configuredRelayRuntime(): Promise<{ relay: RelayAdapter; config: ProviderConfig }> {
  const settings = await getSettings();
  const config = {
    ...settings.providers[0],
    ...(settings.promptTemplate ? { systemPrompt: settings.promptTemplate } : {}),
  };
  const relay = providerManager.getProvider({
    ...config,
    apiKey: await getApiKey(settings.keyStorageMode),
  }, { useCache: false }) as RelayAdapter;
  return { relay, config };
}

async function handleTranslationBatch(
  request: TranslationBatchRequest,
  tabId: number,
): Promise<TranslationBatchResult> {
  const { relay, config } = await configuredRelayRuntime();
  const cached = await Promise.all(request.items.map(async (item) => ({
    item,
    result: await getCached(item.text, request.sourceLang, request.targetLang, config.id),
  })));
  const missing = cached.filter((entry) => !entry.result).map((entry) => entry.item);

  let scheduled: TranslationBatchResult | null = null;
  if (missing.length > 0) {
    scheduled = await translationScheduler.submit({ ...request, items: missing }, tabId, relay, config);
    const sourceById = new Map(missing.map((item) => [item.id, item.text]));
    await Promise.all(scheduled.items.map(async (item) => {
      if (item.status !== 'completed' || item.translated === undefined) return;
      const source = sourceById.get(item.id);
      if (source === undefined) return;
      await setCache(source, request.sourceLang, request.targetLang, config.id, {
        translated: item.translated,
        provider: config.id,
        cached: false,
      });
    }));
  }

  const scheduledById = new Map(scheduled?.items.map((item) => [item.id, item]) ?? []);
  const items = cached.map(({ item, result }) => result
    ? { id: item.id, status: 'completed' as const, translated: result.translated }
    : scheduledById.get(item.id) ?? { id: item.id, status: 'failed' as const, error: 'BATCH_RESULT_MISSING' });
  const status = items.every((item) => item.status === 'completed')
    ? 'completed'
    : scheduled?.status ?? 'failed';
  return {
    taskId: request.taskId,
    batchId: request.batchId,
    requestId: request.requestId,
    status,
    items,
    attempts: scheduled?.attempts ?? 0,
    requestsUsed: scheduled?.requestsUsed ?? 0,
    charsUsed: scheduled?.charsUsed ?? 0,
  };
}

async function handleGetModels(): Promise<MessageResponse<ModelListResult>> {
  try {
    const relay = await configuredRelay();
    const data = await singleFlight('models', () => relay.getModels('manual'));
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'MODEL_LIST_FAILED' };
  }
}

async function handleTestConnection(): Promise<MessageResponse<ConnectionTestResult>> {
  try {
    const relay = await configuredRelay();
    const data = await singleFlight('connection-test', () => relay.testConnectionDetailed());
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'CONNECTION_FAILED' };
  }
}

export async function handleMessage(
  message: Record<string, unknown>,
  sender: RuntimeSenderLike = {},
): Promise<MessageResponse> {
  const extensionId = browser.runtime.id;
  if (!isOwnExtensionSender(sender, extensionId)) return { success: false, error: 'UNTRUSTED_SENDER' };

  switch (message.type) {
    case 'TRANSLATE': {
      if (!isTranslateRequest(message.payload)) return { success: false, error: 'INVALID_TRANSLATE_REQUEST' };
      return handleTranslate(message.payload);
    }
    case 'VERIFY_CONFIG':
      if (!isOptionsSender(sender, extensionId)) return { success: false, error: 'OPTIONS_ONLY' };
      return handleVerifyConfig((message.payload as { providerConfig: ProviderConfig }).providerConfig);
    case 'GET_SETTINGS':
      return { success: true, data: await getSettings() };
    case 'GET_SECRET_STATUS': {
      if (!isOptionsSender(sender, extensionId)) return { success: false, error: 'OPTIONS_ONLY' };
      const settings = await getSettings();
      return { success: true, data: await getSecretStatus(settings.keyStorageMode) };
    }
    case 'GET_MODELS':
      if (!isOptionsSender(sender, extensionId)) return { success: false, error: 'OPTIONS_ONLY' };
      return handleGetModels();
    case 'TEST_CONNECTION':
      if (!isOptionsSender(sender, extensionId)) return { success: false, error: 'OPTIONS_ONLY' };
      return handleTestConnection();
    case 'TRANSLATE_BATCH': {
      const tabId = sender.tab?.id;
      if (tabId == null) return { success: false, error: 'CONTENT_SCRIPT_REQUIRED' };
      try {
        const data = await handleTranslationBatch(message.payload as TranslationBatchRequest, tabId);
        return { success: true, data } as MessageResponse<TranslationBatchResult>;
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'BATCH_FAILED' };
      }
    }
    case 'TASK_CONTROL': {
      const tabId = sender.tab?.id;
      const payload = message.payload as { taskId?: string; sessionId?: string; action?: string };
      if (tabId == null || !payload.taskId || !payload.sessionId) {
        return { success: false, error: 'INVALID_TASK_CONTROL' };
      }
      const journal = await getTaskJournal(payload.taskId, payload.sessionId);
      if (!journal || journal.tabId !== tabId) return { success: false, error: 'TASK_NOT_FOUND' };
      const allowed = ['pause', 'resume', 'cancel', 'restore', 'complete'] as const;
      if (!allowed.includes(payload.action as typeof allowed[number])) {
        return { success: false, error: 'INVALID_TASK_CONTROL' };
      }
      const changed = await translationScheduler.control(
        payload.taskId,
        payload.sessionId,
        payload.action as typeof allowed[number],
      );
      return { success: true, data: changed };
    }
    case 'GET_TASK_RECOVERY': {
      const tabId = sender.tab?.id;
      const payload = message.payload as { taskId?: string; sessionId?: string };
      if (tabId == null || !payload.taskId || !payload.sessionId) {
        return { success: false, error: 'INVALID_RECOVERY_REQUEST' };
      }
      const journal = await getTaskJournal(payload.taskId, payload.sessionId);
      return journal?.tabId === tabId
        ? { success: true, data: journal }
        : { success: false, error: 'TASK_NOT_FOUND' };
    }
    case 'SAVE_SETTINGS': {
      if (!isOptionsSender(sender, extensionId)) return { success: false, error: 'OPTIONS_ONLY' };
      try {
        return { success: true, data: await saveSettings(message.payload as Partial<AppSettings>) };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'SAVE_FAILED' };
      }
    }
    case 'UPDATE_RUNTIME_SETTINGS': {
      const payload = message.payload as Partial<AppSettings> | undefined;
      if (!payload || typeof payload !== 'object') return { success: false, error: 'INVALID_SETTINGS' };
      const patch: Partial<AppSettings> = {};
      if (['icon', 'instant', 'modifier', 'off'].includes(String(payload.selectionTriggerMode))) {
        patch.selectionTriggerMode = payload.selectionTriggerMode;
      }
      if (['ctrl', 'alt', 'shift'].includes(String(payload.selectionModifierKey))) {
        patch.selectionModifierKey = payload.selectionModifierKey;
      }
      return { success: true, data: await saveSettings(patch) };
    }
    case 'PROBE_CONTENT_SCRIPT_ISOLATION': {
      if (!isOptionsSender(sender, extensionId)) return { success: false, error: 'OPTIONS_ONLY' };
      const tabId = Number((message.payload as { tabId?: number } | undefined)?.tabId);
      if (!Number.isInteger(tabId) || tabId < 0) return { success: false, error: 'TAB_REQUIRED' };
      try {
        const response = await browser.tabs.sendMessage(tabId, { type: 'PROBE_CREDENTIAL_ISOLATION' }) as {
          data?: Record<string, unknown>;
        };
        return { success: true, data: publicCredentialIsolationProbe(response?.data ?? {}) };
      } catch {
        return { success: false, error: 'CONTENT_SCRIPT_UNAVAILABLE' };
      }
    }
    case 'CLEAR_SECRET':
      if (!isOptionsSender(sender, extensionId)) return { success: false, error: 'OPTIONS_ONLY' };
      await clearApiKey();
      return { success: true, data: null };
    case 'CLEAR_CACHE':
      if (!isOptionsSender(sender, extensionId)) return { success: false, error: 'OPTIONS_ONLY' };
      await clearTranslationCache();
      return { success: true, data: null };
    case 'GET_CACHE_STATS':
      if (!isOptionsSender(sender, extensionId)) return { success: false, error: 'OPTIONS_ONLY' };
      return { success: true, data: await getCacheStats() };
    default:
      return { success: false, error: `Unknown message type: ${message.type}` };
  }
}
