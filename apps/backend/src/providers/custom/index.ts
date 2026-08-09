import type {
  AccountRequestOptions,
  IAccount,
  IModelRegistry,
  IModelSpec,
  IProvider,
  ProviderExecuteParams,
} from '@/core/interfaces';
import { getProxyConfig } from '@/config/manager';
import { getCavemanPrompt } from '@/core/caveman';
import {
  createOpenAIToAnthropicStreamTransformer,
  finalizeOpenAIToAnthropicResponse,
  mapAnthropicToOpenAI,
} from '@/core/mappers/anthropic-to-openai';
import {
  createOpenAIStreamTransformer,
  finalizeOpenAIResponse,
  sanitizeOpenAIBody,
} from '@/core/mappers/openai-passthrough';
import {
  createAnthropicToOpenAIStreamTransformer,
  finalizeAnthropicToOpenAIResponse,
  mapOpenAIToAnthropic,
} from '@/core/mappers/openai-to-anthropic';
import { executeCustomRequest } from './executor';
import {
  type CustomProviderKeyRecord,
  type CustomProviderModelRecord,
  type CustomProviderRecord,
  getCustomProvider,
  listProviderKeys,
  listProviderModels,
  removeProviderKey,
  resetProviderKeys,
  persistKeyState,
} from './store';

/**
 * Turn a stored model row into the runtime spec the rest of the gateway uses.
 */
function toModelSpec(model: CustomProviderModelRecord): IModelSpec {
  return {
    modelId: model.modelId,
    displayName: model.displayName ?? model.modelId,
    pool: model.pool,
    isThinking: model.isThinking,
    thinkingMode: model.thinkingMode ?? undefined,
    thinkingBudget: model.thinkingBudget ?? undefined,
    maxOutputTokens: model.maxOutputTokens,
    upstreamModelId: model.upstreamModelId ?? model.modelId,
    timeoutMs: model.timeoutMs,
    inputPricePer1M: model.inputPricePer1M ?? undefined,
    outputPricePer1M: model.outputPricePer1M ?? undefined,
  };
}

/**
 * Anthropic in, Anthropic upstream: the body passes through untouched apart
 * from the model swap. Caveman mode is still applied here so the feature
 * behaves the same on every protocol/style combination.
 */
function passthroughAnthropicBody(body: any, upstreamModelId: string): any {
  const passthrough = { ...body, model: upstreamModelId };
  const cavemanPrefix = getCavemanPrompt();

  if (!cavemanPrefix) {
    return passthrough;
  }

  if (typeof passthrough.system === 'string') {
    passthrough.system = `${cavemanPrefix}\n\n${passthrough.system}`;
  } else if (Array.isArray(passthrough.system)) {
    passthrough.system = [{ type: 'text', text: cavemanPrefix }, ...passthrough.system];
  } else {
    passthrough.system = cavemanPrefix;
  }

  return passthrough;
}

/**
 * A user-defined upstream, configured entirely from the dashboard and backed by
 * SQLite. Registered under its own `id`, so clients reach it with
 * `{provider_id}:{model}` exactly like a built-in provider.
 */
export class CustomProvider implements IProvider {
  readonly id: string;
  readonly displayName: string;

  /**
   * Keys and model specs are held in memory rather than read per call.
   *
   * `IProvider` and `IModelRegistry` are synchronous contracts — `getAccounts`,
   * `getSpec` and friends are called on the request path — but a database read
   * is async once Postgres is a supported backend. The snapshot is refreshed
   * whenever anything changes it, which also keeps the hot path off the
   * database entirely.
   */
  private keys: CustomProviderKeyRecord[] = [];
  private specs = new Map<string, IModelSpec>();

  constructor(private record: CustomProviderRecord) {
    this.id = record.id;
    this.displayName = record.displayName;
  }

  async init(): Promise<void> {
    await this.refresh();
  }

  /**
   * Re-read this provider's row, keys and models. Called after any dashboard
   * edit so changes take effect without a restart.
   */
  async refresh(): Promise<void> {
    const fresh = await getCustomProvider(this.id);
    if (fresh) {
      this.record = fresh;
    }

    this.keys = await listProviderKeys(this.id);

    const specs = new Map<string, IModelSpec>();
    for (const model of await listProviderModels(this.id)) {
      if (model.enabled) {
        specs.set(model.modelId.toLowerCase(), toModelSpec(model));
      }
    }
    this.specs = specs;
  }

  getRecord(): CustomProviderRecord {
    return this.record;
  }

  private getSpecs(): Map<string, IModelSpec> {
    return this.specs;
  }

  getModelRegistry(): IModelRegistry {
    return {
      getSpec: (modelId: string): IModelSpec | null => {
        const spec = this.getSpecs().get(modelId.trim().toLowerCase());
        if (spec) {
          return { ...spec };
        }

        // With validation bypassed, let unknown models straight through — the
        // upstream is the authority on what it accepts.
        try {
          if (getProxyConfig().bypassModelValidation) {
            return {
              modelId,
              displayName: modelId,
              pool: 'cli',
              isThinking: false,
              maxOutputTokens: 8192,
              upstreamModelId: modelId,
              timeoutMs: 60_000,
            };
          }
        } catch {
          // Config not loaded (scripts/tests) — fall through to null.
        }

        return null;
      },
      listModelIds: (): string[] => Array.from(this.getSpecs().values()).map((spec) => spec.modelId).sort(),
    };
  }

  getSupportedModels(): string[] {
    return this.getModelRegistry().listModelIds();
  }

  /**
   * API keys are this provider's "accounts": they rotate, they carry a health
   * score, and they show up in the dashboard's account views.
   */
  getAccounts(): IAccount[] {
    return this.keys.map((key) => ({
      id: key.id,
      providerId: this.id,
      healthScore: key.healthScore,
      lastUsed: key.lastUsed,
      email: key.label,
      tokenUsage: key.tokenUsage,
      consecutiveFailures: key.consecutiveFailures,
      cooldowns: key.cooldownUntil > Date.now() ? { default: key.cooldownUntil } : undefined,
    }));
  }

  async getBestAccount(options: AccountRequestOptions): Promise<IAccount | null> {
    const now = Date.now();
    const accounts = this.getAccounts()
      .filter((account) => !options.excludeIds?.includes(account.id))
      .filter((account) => {
        const cooldown = account.cooldowns?.default;
        return typeof cooldown === 'number' ? cooldown <= now : true;
      });

    if (accounts.length === 0) {
      return null;
    }

    return accounts.reduce((best, account) => {
      if (account.healthScore !== best.healthScore) {
        return account.healthScore > best.healthScore ? account : best;
      }
      return account.lastUsed < best.lastUsed ? account : best;
    });
  }

  async updateAccountUsage(accountId: string, success: boolean): Promise<void> {
    const key = this.keys.find((candidate) => candidate.id === accountId);
    if (!key) {
      return;
    }

    key.lastUsed = Date.now();
    if (success) {
      key.consecutiveFailures = 0;
    } else {
      key.consecutiveFailures += 1;
    }
    await persistKeyState(key);
  }

  async execute(params: ProviderExecuteParams): Promise<Response> {
    const { protocol, body, modelSpec } = params;
    const upstreamModelId = modelSpec.upstreamModelId || modelSpec.modelId;
    const publicModelId = `${this.id}:${modelSpec.modelId}`;
    const isStreaming = body.stream === true;
    const upstreamStyle = this.record.apiStyle;

    // Translate the client's protocol into whatever dialect this upstream speaks.
    const upstreamBody =
      upstreamStyle === 'anthropic'
        ? protocol === 'anthropic'
          ? passthroughAnthropicBody(body, upstreamModelId)
          : mapOpenAIToAnthropic(body, upstreamModelId, modelSpec.maxOutputTokens)
        : protocol === 'anthropic'
          ? mapAnthropicToOpenAI(body, upstreamModelId)
          : sanitizeOpenAIBody(body, upstreamModelId);

    const result = await executeCustomRequest({
      provider: this.record,
      body: upstreamBody,
      modelSpec,
      clientId: params.ctx.clientId,
    });

    // Upstream rejected the request itself — hand the error back untouched.
    if (!result.response.ok) {
      return result.response;
    }

    const streamHeaders = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Nougate-Attempts': result.attempts.toString(),
    };

    // Same dialect on both sides: only the public model name needs restoring.
    if (upstreamStyle === protocol) {
      if (!isStreaming) {
        return protocol === 'anthropic'
          ? await this.rewriteAnthropicModel(result.response, publicModelId)
          : await finalizeOpenAIResponse(result.response, publicModelId);
      }

      if (!result.response.body) {
        throw new Error(`No response body from custom provider "${this.id}"`);
      }

      if (protocol === 'anthropic') {
        // Anthropic streams carry the model only in message_start; passing the
        // bytes through untouched is both correct and cheapest.
        return new Response(result.response.body, { status: 200, headers: streamHeaders });
      }

      return new Response(
        result.response.body.pipeThrough(createOpenAIStreamTransformer(publicModelId)),
        { status: 200, headers: streamHeaders },
      );
    }

    // Client spoke Anthropic, upstream speaks OpenAI.
    if (protocol === 'anthropic') {
      const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

      if (!isStreaming) {
        return await finalizeOpenAIToAnthropicResponse(result.response, publicModelId, messageId);
      }
      if (!result.response.body) {
        throw new Error(`No response body from custom provider "${this.id}"`);
      }
      return new Response(
        result.response.body.pipeThrough(
          createOpenAIToAnthropicStreamTransformer(publicModelId, messageId),
        ),
        { status: 200, headers: streamHeaders },
      );
    }

    // Client spoke OpenAI, upstream speaks Anthropic.
    if (!isStreaming) {
      return await finalizeAnthropicToOpenAIResponse(result.response, publicModelId);
    }
    if (!result.response.body) {
      throw new Error(`No response body from custom provider "${this.id}"`);
    }
    return new Response(
      result.response.body.pipeThrough(createAnthropicToOpenAIStreamTransformer(publicModelId)),
      { status: 200, headers: streamHeaders },
    );
  }

  /**
   * Restore the public `provider:model` name on an Anthropic response.
   */
  private async rewriteAnthropicModel(response: Response, publicModelId: string): Promise<Response> {
    try {
      const data = await response.json();
      data.model = publicModelId;
      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } catch {
      return response;
    }
  }

  getConfig(): any {
    return {
      ...this.record,
      keyCount: this.keys.length,
      modelCount: this.getSupportedModels().length,
    };
  }

  async resetAllAccounts(): Promise<void> {
    await resetProviderKeys(this.id);
    await this.refresh();
  }

  async resetAccount(accountId: string): Promise<void> {
    const key = this.keys.find((candidate) => candidate.id === accountId);
    if (!key) {
      return;
    }
    key.healthScore = 100;
    key.cooldownUntil = 0;
    key.consecutiveFailures = 0;
    await persistKeyState(key);
  }

  async removeAccount(accountId: string): Promise<void> {
    await removeProviderKey(this.id, accountId);
    await this.refresh();
  }

  async markAccountCooldown(accountId: string, _pool: string, duration?: string): Promise<void> {
    const key = this.keys.find((candidate) => candidate.id === accountId);
    if (!key) {
      return;
    }
    const seconds = duration ? parseInt(duration.replace(/[^0-9]/g, ''), 10) || 60 : 60;
    key.cooldownUntil = Date.now() + seconds * 1000;
    await persistKeyState(key);
  }

  getCooldowns(): Record<string, number> {
    const cooldowns: Record<string, number> = {};
    for (const key of this.keys) {
      if (key.cooldownUntil > Date.now()) {
        cooldowns[key.id] = key.cooldownUntil;
      }
    }
    return cooldowns;
  }

  async handleAccountAction(accountId: string, action: string, payload?: any): Promise<any> {
    switch (action) {
      case 'reset':
        return this.resetAccount(accountId);
      case 'cooldown':
        return this.markAccountCooldown(accountId, 'cli', payload?.duration || '60s');
      default:
        throw new Error(`Action "${action}" not supported for custom providers`);
    }
  }
}
