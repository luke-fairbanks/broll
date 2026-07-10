import type { Provider } from './types.js';

export interface ProviderChoice {
  provider: Provider;
  /** Why this provider was chosen — surfaced to the agent so key problems are diagnosable. */
  reason: string;
}

export interface ProviderStatus {
  name: string;
  capabilities: ReadonlyArray<'image' | 'video'>;
  configured: boolean;
  requirement: string;
}

export class ProviderRegistry {
  constructor(
    private readonly providers: Provider[],
    private readonly defaults: { image?: string; video?: string } = {},
  ) {}

  statuses(): ProviderStatus[] {
    return this.providers.map((p) => ({
      name: p.name,
      capabilities: p.capabilities,
      configured: p.isConfigured(),
      requirement: p.requirement,
    }));
  }

  pick(kind: 'image' | 'video', explicit?: string): ProviderChoice {
    const capable = this.providers.filter((p) => p.capabilities.includes(kind));

    if (explicit) {
      const provider = capable.find((p) => p.name === explicit);
      if (!provider) {
        throw new Error(
          `No ${kind} provider named "${explicit}". Available: ${capable.map((p) => p.name).join(', ')}.`,
        );
      }
      if (!provider.isConfigured()) {
        throw new Error(`Provider "${explicit}" is not configured — it needs ${provider.requirement}.`);
      }
      return { provider, reason: 'explicitly requested' };
    }

    const preferred = this.defaults[kind];
    if (preferred) {
      const provider = capable.find((p) => p.name === preferred);
      if (provider?.isConfigured()) {
        return { provider, reason: `default ${kind} provider from config` };
      }
    }

    const firstReal = capable.find((p) => p.name !== 'mock' && p.isConfigured());
    if (firstReal) return { provider: firstReal, reason: `first configured ${kind} provider` };

    const mock = capable.find((p) => p.name === 'mock');
    if (mock) {
      return {
        provider: mock,
        reason: `no ${kind} provider keys found — using the built-in mock (add OPENAI_API_KEY or GEMINI_API_KEY for real generation)`,
      };
    }
    throw new Error(`No ${kind} provider available.`);
  }
}
