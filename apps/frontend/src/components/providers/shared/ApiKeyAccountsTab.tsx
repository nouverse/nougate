import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { KeyRound, Plus, RotateCcw, Trash2 } from 'lucide-react';

import { api } from '@/lib/api';
import { formatTimestamp } from '@/lib/format';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import type { Account, AccountCopy } from '@/lib/types';

interface Props {
  providerId: string;
  accounts: Account[];
  refreshQueries: () => void;
  /** Which credential this provider actually wants. Decides the wording, not the mechanics. */
  flow?: 'api-key' | 'oauth-token';
  /** The provider's own words, which win over the flow's defaults below (`accountCopy`). */
  accountCopy?: AccountCopy | null;
}

/**
 * What the form says, per flow.
 *
 * The mechanics are identical — one secret, one label, rotate on failure — so the component is
 * shared. The *words* are not interchangeable, and treating them as if they were is how a
 * subscription-OAuth provider came to be labelled "ADD AN API KEY" with an `sk-…` placeholder, which
 * made it look like a redundant copy of a custom provider.
 */
const COPY = {
  'api-key': {
    title: 'ADD AN API KEY',
    hint: 'Keys rotate like accounts: the healthiest one wins, a 429 puts it in cooldown and the next key takes over.',
    placeholder: 'sk-...',
    button: 'Add key',
  },
  'oauth-token': {
    title: 'ADD A SUBSCRIPTION TOKEN',
    // Neutral on purpose: how to get the token is the provider's to say (`accountCopy.hint`).
    hint: 'Paste a token issued for your subscription. Tokens rotate like accounts: the healthiest wins, a 429 puts it in cooldown.',
    placeholder: 'paste the token',
    button: 'Add token',
  },
} as const;

/**
 * The accounts view for any provider whose accounts are API keys.
 *
 * Nothing here is specific to one provider: it is selected by the backend's
 * declared `accountFlow`, so a future key-based provider gets it for free. Keys
 * rotate exactly like OAuth accounts do — same health score, same cooldown — so
 * this renders the same columns as the other account tabs.
 */
export function ApiKeyAccountsTab({
  providerId,
  accounts,
  refreshQueries,
  flow = 'api-key',
  accountCopy,
}: Props) {
  const copy = {
    ...COPY[flow],
    ...(accountCopy?.hint ? { hint: accountCopy.hint } : {}),
    ...(accountCopy?.pastePlaceholder ? { placeholder: accountCopy.pastePlaceholder } : {}),
    ...(accountCopy?.button ? { button: accountCopy.button } : {}),
  };
  const [draft, setDraft] = useState({ apiKey: '', label: '' });
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Account | null>(null);

  const addMutation = useMutation({
    mutationFn: () =>
      api.post(`/api/providers/${providerId}/accounts/add`, {
        apiKey: draft.apiKey.trim(),
        label: draft.label.trim() || undefined,
      }),
    onSuccess: () => {
      setDraft({ apiKey: '', label: '' });
      setError(null);
      refreshQueries();
    },
    onError: (mutationError: any) =>
      setError(mutationError?.message ?? 'Could not add that key.'),
  });

  const removeMutation = useMutation({
    mutationFn: (accountId: string) =>
      api.delete(`/api/providers/${providerId}/accounts/${encodeURIComponent(accountId)}`),
    onSuccess: () => {
      setPendingDelete(null);
      refreshQueries();
    },
  });

  const resetMutation = useMutation({
    mutationFn: (accountId: string) =>
      api.post(`/api/providers/${providerId}/accounts/${encodeURIComponent(accountId)}/action`, {
        action: 'reset',
      }),
    onSuccess: refreshQueries,
  });

  const now = Date.now();

  return (
    <div className="space-y-4 min-w-0">
      <div className="card bg-base-200 border border-base-300 shadow-sm">
        <div className="card-body p-5 space-y-4 min-w-0">
          <div className="min-w-0">
            <h3 className="card-title text-sm font-bold tracking-wide flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary shrink-0" />
              {copy.title}
            </h3>
            <p className="text-xs text-base-content/50 mt-1">{copy.hint}</p>
          </div>

          <form
            className="flex flex-col sm:flex-row gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              addMutation.mutate();
            }}
          >
            <input
              type="password"
              required
              placeholder={copy.placeholder}
              className="input input-bordered input-sm flex-1 min-w-0 bg-base-100 font-mono"
              value={draft.apiKey}
              onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })}
            />
            <input
              type="text"
              placeholder={accounts.length === 0 ? 'primary' : 'label (optional)'}
              className="input input-bordered input-sm w-full sm:w-40 bg-base-100"
              value={draft.label}
              onChange={(event) => setDraft({ ...draft, label: event.target.value })}
            />
            <button
              type="submit"
              className="btn btn-sm btn-primary rounded-xl font-semibold gap-1.5 shrink-0"
              disabled={addMutation.isPending}
            >
              <Plus className="w-3.5 h-3.5" />
              {copy.button}
            </button>
          </form>

          {error && <p className="text-xs text-error font-semibold">{error}</p>}
        </div>
      </div>

      <div className="card bg-base-200 border border-base-300 shadow-sm">
        <div className="card-body p-5 space-y-4 min-w-0">
          <h3 className="card-title text-sm font-bold tracking-wide">
            KEY POOL ({accounts.length})
          </h3>

          <div className="overflow-x-auto min-w-0">
            <table className="table table-sm">
              <thead>
                <tr className="text-base-content/50 text-[10px] uppercase tracking-wider">
                  <th>Label</th>
                  <th className="text-right">Health</th>
                  <th className="text-right">Tokens</th>
                  <th>Last used</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => {
                  const cooldown = account.cooldowns?.default;
                  const inCooldown = typeof cooldown === 'number' && cooldown > now;
                  return (
                    <tr key={account.id}>
                      <td className="font-semibold">{account.email || account.id}</td>
                      <td className="text-right font-mono">
                        {account.healthScore}
                        {inCooldown && (
                          <span className="badge badge-xs badge-warning ml-1.5 font-bold">
                            cooldown
                          </span>
                        )}
                      </td>
                      <td className="text-right font-mono text-base-content/60">
                        {(account.tokenUsage ?? 0).toLocaleString()}
                      </td>
                      <td className="text-base-content/60">
                        {account.lastUsed ? formatTimestamp(account.lastUsed) : 'never'}
                      </td>
                      <td className="text-right whitespace-nowrap">
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs gap-1"
                          title="Restore health and clear any cooldown"
                          onClick={() => resetMutation.mutate(account.id)}
                        >
                          <RotateCcw className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          className="btn btn-ghost btn-xs text-error"
                          onClick={() => setPendingDelete(account)}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
                {accounts.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center text-base-content/40 py-6 text-xs">
                      No keys yet — requests to this provider will fail until you add one.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <ConfirmModal
        isOpen={!!pendingDelete}
        title="Remove this key?"
        message={`"${pendingDelete?.email || pendingDelete?.id}" stops serving requests immediately. This cannot be undone.`}
        confirmText="Remove key"
        isDestructive
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => pendingDelete && removeMutation.mutate(pendingDelete.id)}
      />
    </div>
  );
}
