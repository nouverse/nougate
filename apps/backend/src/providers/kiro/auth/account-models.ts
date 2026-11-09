/**
 * What each Kiro account's own catalogue had, last time it was read (`index.ts`): accounts differ in
 * what they may call, and selection sends a request for a model to an account whose catalogue has it
 * (`KiroAccountPool.best`). Here, and not beside the fetch, so the pool can read it without importing
 * the provider.
 */

import { UnitedAccountLists } from '@/core/live-models';
import type { KiroModelDef } from '../config/model-specs';
import type { KiroAccount } from './types';

export const kiroAccountCatalogues = new UnitedAccountLists<KiroAccount, KiroModelDef>();
