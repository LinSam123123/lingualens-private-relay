import type { AppSettings, ProviderConfig } from './types';
import { resolveDefaultTargetLang } from './default-target-lang.ts';

export const DEFAULT_SYSTEM_PROMPT =
  'You are a professional translator. Translate the following text from {sourceLang} to {targetLang}. Preserve the original formatting, tone, and style. Only output the translated text, nothing else.';

export { SUPPORTED_LANGUAGES } from './languages.ts';

export const PROVIDER_PRESETS: Record<string, Omit<ProviderConfig, 'id' | 'enabled'>> = {
  'openai-compat': {
    type: 'openai-compat',
    name: 'OpenAI Compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: '',
  },
  ollama: {
    type: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434',
    model: 'llama3',
  },
  lmstudio: {
    type: 'lmstudio',
    name: 'LM Studio',
    baseUrl: 'http://localhost:1234',
    model: '',
  },
  openai: {
    type: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
  },
  deepseek: {
    type: 'openai-compat',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
  },
  deepl: {
    type: 'deepl',
    name: 'DeepL',
    baseUrl: 'https://api-free.deepl.com',
  },
  google: {
    type: 'google',
    name: 'Google Translate',
    baseUrl: 'https://translation.googleapis.com',
  },
  custom: {
    type: 'custom',
    name: 'Custom API',
    baseUrl: 'https://api.example.com/translate',
  },
};

export const PRIVATE_RELAY_PROVIDER_ID = 'private-relay';

export const DEFAULT_SETTINGS: AppSettings = {
  defaultProvider: PRIVATE_RELAY_PROVIDER_ID,
  fallbackProviders: [],
  defaultTargetLang: resolveDefaultTargetLang(),
  defaultSourceLang: 'auto',
  providers: [
    {
      id: PRIVATE_RELAY_PROVIDER_ID,
      type: 'relay',
      name: 'Private Relay',
      enabled: true,
      baseUrl: '',
      model: '',
      protocol: 'chat-completions',
      temperature: 0.2,
      timeoutMs: 25_000,
      maxConcurrency: 2,
      maxCharsPerRequest: 8_000,
      maxItemsPerRequest: 0,
      maxPageChars: 100_000,
      maxPageRequests: 100,
      retryGatewayErrors: false,
      streamTranslations: false,
      fastMode: false,
    },
  ],
  chunkingMode: 'quality',
  selectionTriggerMode: 'icon',
  selectionModifierKey: 'ctrl',
  keyStorageMode: 'session',
};
