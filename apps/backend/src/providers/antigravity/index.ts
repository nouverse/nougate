import type {
  AccountRequestOptions,
  IAccount,
  IModelRegistry,
  IProvider,
} from '../../core/interfaces';
import {
  getAccounts,
  getBestAccount as getBestAntigravityAccount,
  initManager,
  updateAccountUsage as updateAntigravityAccountUsage,
} from './auth/manager';
import type { AntigravityAccount } from './auth/types';
import { antigravityModelRegistry, loadModelSpecOverrides } from './config/model-specs';
import {
  getAntigravityConfig,
  loadAntigravityConfig,
  saveAntigravityConfig,
  updateAntigravityConfig,
  type AntigravityConfig,
} from './provider-config';

/**
 * Concrete provider implementation for Antigravity accounts and model registry.
 */
export class AntigravityProvider implements IProvider {
  readonly id = 'antigravity';

  readonly displayName = 'Antigravity';

  /**
   * Initialize provider-owned config, runtime model overrides, and account state.
   */
  async init(): Promise<void> {
    await loadAntigravityConfig();
    await loadModelSpecOverrides();
    await initManager();
  }

  /**
   * Select the best available account for the given routing constraints.
   */
  async getBestAccount(options: AccountRequestOptions): Promise<IAccount | null> {
    const account = await getBestAntigravityAccount(
      options.pool as 'cli' | 'sandbox' | undefined,
      options.modelId,
      options.clientId,
      options.excludeIds,
      options.skipRescue,
    );

    return account ? this.mapAccount(account) : null;
  }

  /**
   * Forward usage updates to the provider-local account manager.
   */
  async updateAccountUsage(
    accountId: string,
    success: boolean,
    meta: {
      modelId?: string;
      pool?: string;
      clientId?: string;
      statusCode?: number;
    },
  ): Promise<void> {
    await updateAntigravityAccountUsage(
      accountId,
      success,
      meta.modelId,
      meta.pool,
      meta.clientId,
      meta.statusCode,
    );
  }

  /**
   * Return the current provider accounts in the shared registry shape.
   */
  getAccounts(): IAccount[] {
    return getAccounts().map((account) => this.mapAccount(account));
  }

  /**
   * Return the provider-local model registry.
   */
  getModelRegistry(): IModelRegistry {
    return antigravityModelRegistry;
  }

  /**
   * Convert an Antigravity account into the shared provider interface.
   */
  private mapAccount(account: AntigravityAccount): IAccount {
    return {
      id: account.email,
      providerId: this.id,
      healthScore: account.healthScore,
      lastUsed: account.lastUsed,
      capabilities: account.capabilities,
    };
  }
}

export {
  getAntigravityConfig,
  loadAntigravityConfig,
  saveAntigravityConfig,
  updateAntigravityConfig,
};
export type { AntigravityConfig };
