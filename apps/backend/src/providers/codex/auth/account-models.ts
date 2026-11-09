/**
 * What each Codex account's own model list had, last time it was read (`api/models.ts`): plans
 * differ, and selection sends a request for a model to an account whose list has it
 * (`getBestAccount`). Here, and not beside the fetch, so selection can read it without importing the
 * fetch and everything it imports.
 */

import { UnitedAccountLists } from '@/core/live-models';
import type { IModelSpec } from '@/core/interfaces';
import type { CodexAccount } from './types';

export const codexAccountLists = new UnitedAccountLists<CodexAccount, IModelSpec>();
