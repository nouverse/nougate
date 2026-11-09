/**
 * What each Copilot account's own model list had, last time it was read (`upstream/models.ts`): seats
 * differ, and selection sends a request for a model to an account whose list has it
 * (`getBestAccount`). Here, and not beside the fetch, so selection can read it without importing the
 * fetch.
 */

import { UnitedAccountLists } from '@/core/live-models';
import type { IModelSpec } from '@/core/interfaces';
import type { CopilotAccount } from './types';

export const copilotAccountLists = new UnitedAccountLists<CopilotAccount, IModelSpec>();
