import { RelayAdapter } from './relay';
import { BaseProvider } from './base';
import type { ProviderConfig } from '../shared/types';

export class ProviderManager {
  private providers = new Map<string, BaseProvider>();

  createProvider(config: ProviderConfig): BaseProvider {
    switch (config.type) {
      case 'relay':
        return new RelayAdapter(config);
      default:
        throw new Error('RELAY_PROVIDER_REQUIRED');
    }
  }

  getProvider(config: ProviderConfig, { useCache = true } = {}): BaseProvider {
    if (useCache) {
      const cached = this.providers.get(config.id);
      if (cached) return cached;
    }
    const provider = this.createProvider(config);
    if (useCache) {
      this.providers.set(config.id, provider);
    }
    return provider;
  }

  clearCache(): void {
    this.providers.clear();
  }
}
