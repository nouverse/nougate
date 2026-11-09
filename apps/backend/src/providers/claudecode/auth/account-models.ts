/**
 * What each credential's own model list had, last time it was read (`api/models.ts`): plans differ,
 * and selection sends a request for a model to a credential whose list has it (`getBestAccount`).
 * Here, and not beside the fetch, so selection can read it without importing the fetch.
 */

import { UnitedAccountLists } from '@/core/live-models';
import type { IModelSpec } from '@/core/interfaces';
import type { ClaudeCodeAccount } from './types';

export const claudeCodeAccountLists = new UnitedAccountLists<ClaudeCodeAccount, IModelSpec>();
