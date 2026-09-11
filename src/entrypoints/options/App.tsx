import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  AppSettings,
  ConnectionTestResult,
  MessageResponse,
  ModelListResult,
  ProviderConfig,
  SecretStatus,
  SelectionModifierKey,
  SelectionTriggerMode,
} from '../../shared/types';
import {
  DEFAULT_SETTINGS,
  DEFAULT_SYSTEM_PROMPT,
  PRIVATE_RELAY_PROVIDER_ID,
  SUPPORTED_LANGUAGES,
} from '../../shared/constants';
import { AppLogo } from '../../shared/AppLogo';
import { AVAILABLE_UI_LANGUAGES, getUILanguage, setUILanguage } from '../../shared/i18n';
import {
  hostPermissionOrigins,
  hostPermissionQuery,
  resolveHostPermissionBrowser,
} from '../../shared/url-policy';

export function App() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [secret, setSecret] = useState<SecretStatus>({
    hasKey: false,
    storageMode: 'session',
    localKeyStorageAvailable: true,
  });
  const [apiKey, setApiKey] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [testing, setTesting] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [diagnostic, setDiagnostic] = useState<ConnectionTestResult | null>(null);
  const [uiLang, setUiLang] = useState(getUILanguage());
  const originalPermissionRef = useRef<string | null>(null);

  const relay = settings.providers[0] ?? DEFAULT_SETTINGS.providers[0];

  useEffect(() => {
    void Promise.all([
      browser.runtime.sendMessage({ type: 'GET_SETTINGS' }) as Promise<MessageResponse<AppSettings>>,
      browser.runtime.sendMessage({ type: 'GET_SECRET_STATUS' }) as Promise<MessageResponse<SecretStatus>>,
    ]).then(([settingsResult, secretResult]) => {
      if (settingsResult.success) {
        setSettings(settingsResult.data);
        const url = settingsResult.data.providers[0]?.baseUrl;
        try {
          originalPermissionRef.current = url ? hostPermissionQuery(url).origins[0] : null;
        } catch {
          originalPermissionRef.current = null;
        }
      }
      if (secretResult.success) setSecret(secretResult.data);
    });
  }, []);

  const updateRelay = (patch: Partial<ProviderConfig>) => {
    setSettings((current) => ({
      ...current,
      providers: [{ ...current.providers[0], ...patch }],
      defaultProvider: PRIVATE_RELAY_PROVIDER_ID,
      fallbackProviders: [],
    }));
    setDirty(true);
    setNotice(null);
    setDiagnostic(null);
  };

  const updateSettings = (patch: Partial<AppSettings>) => {
    setSettings((current) => ({ ...current, ...patch }));
    setDirty(true);
    setNotice(null);
  };

  const refreshSecret = async () => {
    const response: MessageResponse<SecretStatus> = await browser.runtime.sendMessage({ type: 'GET_SECRET_STATUS' });
    if (response.success) setSecret(response.data);
  };

  const saveAndAuthorize = async () => {
    setNotice(null);
    let permission: { origins: string[] };
    try {
      permission = hostPermissionQuery(relay.baseUrl);
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : 'BASE_URL_INVALID' });
      return;
    }

    const permissionOrigin = permission.origins[0];
    const oldPermission = originalPermissionRef.current;
    let granted = false;
    setSaving(true);
    try {
      granted = await browser.permissions.request(permission);
      if (!granted) throw new Error('HOST_PERMISSION_DENIED');
      const provider = { ...relay, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) };
      const response: MessageResponse<AppSettings> = await browser.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        payload: { ...settings, providers: [provider] },
      });
      if (!response.success) throw new Error(response.error);

      let warning = '';
      if (oldPermission && oldPermission !== permissionOrigin) {
        const removed = await browser.permissions.remove(hostPermissionOrigins(oldPermission));
        if (!removed) warning = ' OLD_HOST_PERMISSION_NOT_REMOVED';
      }
      originalPermissionRef.current = permissionOrigin;
      setSettings(response.data);
      setApiKey('');
      setDirty(false);
      await refreshSecret();
      setNotice({ ok: true, text: `${t('options.saved')}${warning}` });
    } catch (error) {
      if (granted && permissionOrigin !== oldPermission) {
        await browser.permissions.remove(permission).catch(() => false);
      }
      const message = error instanceof Error ? error.message : 'SAVE_FAILED';
      setNotice({
        ok: false,
        text: message === 'LOCAL_KEY_STORAGE_UNAVAILABLE'
          ? t('options.localKeyStorageUnavailable')
          : message,
      });
    } finally {
      setSaving(false);
    }
  };

  const refreshModels = async () => {
    if (loadingModels) return;
    setLoadingModels(true);
    setNotice(null);
    try {
      const response: MessageResponse<ModelListResult> = await browser.runtime.sendMessage({ type: 'GET_MODELS' });
      if (!response.success) throw new Error(response.error);
      setModels(response.data.models);
      setNotice({ ok: true, text: `${response.data.models.length} models (HTTP ${response.data.httpStatus})` });
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : 'MODEL_LIST_FAILED' });
    } finally {
      setLoadingModels(false);
    }
  };

  const testConnection = async () => {
    if (testing) return;
    setTesting(true);
    setDiagnostic(null);
    setNotice(null);
    try {
      const response: MessageResponse<ConnectionTestResult> = await browser.runtime.sendMessage({ type: 'TEST_CONNECTION' });
      if (!response.success) throw new Error(response.error);
      setDiagnostic(response.data);
    } catch (error) {
      setNotice({ ok: false, text: error instanceof Error ? error.message : 'CONNECTION_FAILED' });
    } finally {
      setTesting(false);
    }
  };

  const clearKey = async () => {
    const response: MessageResponse = await browser.runtime.sendMessage({ type: 'CLEAR_SECRET' });
    if (!response.success) {
      setNotice({ ok: false, text: response.error });
      return;
    }
    setApiKey('');
    await refreshSecret();
    setNotice({ ok: true, text: t('options.keyCleared') });
  };

  const clearCache = async () => {
    const response: MessageResponse = await browser.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    setNotice(response.success
      ? { ok: true, text: t('options.cacheCleared') }
      : { ok: false, text: response.error });
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <main className="max-w-3xl mx-auto py-8 px-5">
        <header className="flex items-center gap-3 mb-7">
          <AppLogo className="w-10 h-10 shrink-0" />
          <div className="min-w-0">
            <h1 className="text-2xl font-bold text-gray-800">LinguaLens</h1>
            <p className="text-sm text-gray-500">{t('options.privateRelaySettings')}</p>
          </div>
        </header>

        <Section title={t('options.relayConnection')}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={t('options.providerName')}>
              <input className="input" value={relay.name} maxLength={80} onChange={(e) => updateRelay({ name: e.target.value })} />
            </Field>
            <Field label={t('options.protocol')}>
              <select className="input" value={relay.protocol ?? 'chat-completions'} onChange={(e) => updateRelay({ protocol: e.target.value as ProviderConfig['protocol'] })}>
                <option value="chat-completions">Chat Completions</option>
                <option value="responses">Responses</option>
              </select>
            </Field>
          </div>
          <Field label={t('options.apiBaseUrl')}>
            <input className="input" value={relay.baseUrl} placeholder="https://relay.example.com/v1" onChange={(e) => updateRelay({ baseUrl: e.target.value })} />
          </Field>
          <p className="text-xs text-gray-500 mt-2">{t('options.baseUrlPolicy')}</p>
          {resolveHostPermissionBrowser() === 'firefox' && (
            <p className="text-xs text-gray-500 mt-2">{t('options.firefoxHostPermissionScope')}</p>
          )}
        </Section>

        <Section title={t('options.credentials')}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={t('options.keyStorage')}>
              <select className="input" value={settings.keyStorageMode} onChange={(e) => updateSettings({ keyStorageMode: e.target.value as AppSettings['keyStorageMode'] })}>
                <option value="session">{t('options.keySession')}</option>
                <option value="local" disabled={!secret.localKeyStorageAvailable}>{t('options.keyLocal')}</option>
              </select>
            </Field>
            <Field label={t('options.apiKey')}>
              <input className="input" type="password" autoComplete="new-password" value={apiKey} placeholder={secret.hasKey ? secret.maskedKey ?? 'Configured' : ''} onChange={(e) => { setApiKey(e.target.value); setDirty(true); }} />
            </Field>
          </div>
          {!secret.localKeyStorageAvailable && (
            <p className="text-xs text-gray-500 mt-2">{t('options.localKeyStorageUnavailable')}</p>
          )}
          <div className="mt-3 flex items-center justify-between gap-3">
            <span className="text-xs text-gray-500">{secret.hasKey ? t('options.keyConfigured') : t('options.keyMissing')}</span>
            {secret.hasKey && <button type="button" className="btn-secondary" onClick={() => void clearKey()}>{t('options.clearKey')}</button>}
          </div>
        </Section>

        <Section title={t('options.modelAndDiagnostics')}>
          <Field label={t('options.model')}>
            <div className="flex gap-2">
              <input className="input flex-1" list="relay-models" value={relay.model ?? ''} maxLength={200} onChange={(e) => updateRelay({ model: e.target.value })} />
              <datalist id="relay-models">{models.map((model) => <option key={model} value={model} />)}</datalist>
              <button type="button" className="btn-secondary shrink-0" disabled={loadingModels || dirty} onClick={() => void refreshModels()}>{loadingModels ? t('options.loading') : t('options.refreshModels')}</button>
            </div>
          </Field>
          <div className="flex flex-wrap gap-2 mt-4">
            <button type="button" className="btn-secondary" disabled={testing || dirty} onClick={() => void testConnection()}>{testing ? t('options.testing') : t('options.testConnection')}</button>
            <button type="button" className="btn-secondary" onClick={() => void clearCache()}>{t('options.clearCache')}</button>
            {dirty && <span className="text-xs text-amber-700 self-center">{t('options.saveBeforeDiagnostics')}</span>}
          </div>
          {diagnostic && <Diagnostic result={diagnostic} />}
        </Section>

        <Section title={t('options.translationLimits')}>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <NumberField label={t('options.timeout')} value={(relay.timeoutMs ?? 25_000) / 1000} min={5} max={120} onChange={(value) => updateRelay({ timeoutMs: value * 1000 })} />
            <NumberField label={t('options.concurrency')} value={relay.maxConcurrency ?? 2} min={1} max={4} onChange={(value) => updateRelay({ maxConcurrency: value })} />
            <NumberField label={t('options.batchChars')} value={relay.maxCharsPerRequest ?? 8_000} min={500} max={20_000} onChange={(value) => updateRelay({ maxCharsPerRequest: value })} />
            <NumberField label={t('options.pageChars')} value={relay.maxPageChars ?? 100_000} min={1_000} max={1_000_000} onChange={(value) => updateRelay({ maxPageChars: value })} />
            <NumberField label={t('options.pageRequests')} value={relay.maxPageRequests ?? 100} min={1} max={1_000} onChange={(value) => updateRelay({ maxPageRequests: value })} />
          </div>
          <label className="mt-5 flex items-start gap-3 cursor-pointer">
            <input type="checkbox" className="mt-1" checked={relay.retryGatewayErrors === true} onChange={(e) => updateRelay({ retryGatewayErrors: e.target.checked })} />
            <span><strong className="block text-sm text-gray-700">{t('options.gatewayRetry')}</strong><span className="block text-xs text-gray-500 mt-1">{t('options.gatewayRetryWarning')}</span></span>
          </label>
        </Section>

        <Section title={t('options.languagesAndPrompt')}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label={t('options.sourceLanguage')}>
              <select className="input" value={settings.defaultSourceLang} onChange={(e) => updateSettings({ defaultSourceLang: e.target.value })}>{SUPPORTED_LANGUAGES.map((lang) => <option key={lang.code} value={lang.code}>{lang.name}</option>)}</select>
            </Field>
            <Field label={t('options.targetLanguage')}>
              <select className="input" value={settings.defaultTargetLang} onChange={(e) => updateSettings({ defaultTargetLang: e.target.value })}>{SUPPORTED_LANGUAGES.filter((lang) => lang.code !== 'auto').map((lang) => <option key={lang.code} value={lang.code}>{lang.name}</option>)}</select>
            </Field>
          </div>
          <Field label={t('options.promptTemplate')}>
            <textarea className="input min-h-28 resize-y" maxLength={12_000} value={settings.promptTemplate ?? DEFAULT_SYSTEM_PROMPT} onChange={(e) => updateSettings({ promptTemplate: e.target.value })} />
          </Field>
        </Section>

        <Section title={t('options.selectionTriggerMode')}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {(['icon', 'instant', 'modifier', 'off'] as SelectionTriggerMode[]).map((mode) => <label key={mode} className="border border-gray-200 rounded-md p-3 text-sm cursor-pointer"><input type="radio" name="trigger" className="mr-2" checked={settings.selectionTriggerMode === mode} onChange={() => updateSettings({ selectionTriggerMode: mode })} />{t(`options.triggerMode${mode[0].toUpperCase()}${mode.slice(1)}`)}</label>)}
          </div>
          {settings.selectionTriggerMode === 'modifier' && <Field label={t('options.selectionModifierKey')}><select className="input max-w-40" value={settings.selectionModifierKey} onChange={(e) => updateSettings({ selectionModifierKey: e.target.value as SelectionModifierKey })}>{(['ctrl', 'alt', 'shift'] as SelectionModifierKey[]).map((key) => <option key={key} value={key}>{key.toUpperCase()}</option>)}</select></Field>}
        </Section>

        <Section title={t('options.uiLanguage')}>
          <select className="input" value={uiLang} onChange={(e) => { setUiLang(e.target.value); void setUILanguage(e.target.value); }}>{AVAILABLE_UI_LANGUAGES.map((lang) => <option key={lang.code} value={lang.code}>{lang.name}</option>)}</select>
        </Section>

        {notice && <div className={`mb-4 px-4 py-3 rounded-md text-sm ${notice.ok ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`} role="status">{notice.text}</div>}
        <button type="button" className="w-full py-3 rounded-md bg-blue-600 text-white font-medium disabled:opacity-50" disabled={saving} onClick={() => void saveAndAuthorize()}>{saving ? t('options.saving') : t('options.saveAndAuthorize')}</button>
      </main>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="bg-white border border-gray-200 rounded-lg p-5 mb-5"><h2 className="text-base font-semibold text-gray-800 mb-4">{title}</h2>{children}</section>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block mt-3 first:mt-0"><span className="block text-sm font-medium text-gray-700 mb-1.5">{label}</span>{children}</label>;
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (value: number) => void }) {
  return <Field label={label}><input className="input" type="number" value={value} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} /></Field>;
}

function Diagnostic({ result }: { result: ConnectionTestResult }) {
  const { t } = useTranslation();
  const rows = [
    ['Reachable', result.reachable],
    ['Authenticated', result.authenticated],
    ['Model', result.modelAvailable],
    ['Format', result.formatCompatible],
  ];
  const message = result.message === 'REDIRECT_NOT_ALLOWED'
    ? t('options.redirectNotAllowed')
    : result.message;
  return <div className="mt-4 border border-gray-200 rounded-md p-3 text-sm"><div className="grid grid-cols-2 gap-2">{rows.map(([label, value]) => <div key={String(label)} className="flex justify-between gap-2"><span className="text-gray-500">{label}</span><strong className={value === true ? 'text-green-700' : value === false ? 'text-red-700' : 'text-gray-500'}>{value === null ? 'N/A' : value ? 'OK' : 'Failed'}</strong></div>)}</div><p className="mt-3 text-gray-700 break-words">HTTP {result.httpStatus ?? 'N/A'}: {message}</p>{result.sample && <p className="mt-1 text-gray-500 break-words">{result.sample}</p>}</div>;
}
