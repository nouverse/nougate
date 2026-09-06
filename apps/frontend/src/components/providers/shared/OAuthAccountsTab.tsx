import React, { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Account } from '@/lib/types';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { AccountsTable } from './AccountsTable';
import { AccountCard } from './AccountCard';
import { Plus, Shield } from 'lucide-react';

/**
 * What the sign-in modal says, per provider.
 *
 * The mechanics are identical — open an authorize URL, come back with a code, exchange it — so the
 * component is shared. The *words* are not, and hardcoding them is a bug that has now been made
 * twice in this directory: a Claude Code provider whose OAuth pointed correctly at
 * `claude.ai/oauth/authorize` while the modal above it said "Add Google Account" and told the
 * operator to wait for a failed `localhost:3000` redirect that was never going to happen.
 *
 * Keyed by provider id, which is the one place that is legitimate: this is presentation copy, not
 * behaviour. Everything the component *does* still comes from the provider's declared `accountFlow`.
 */
const COPY: Record<string, {
  title: string;
  intro: string;
  button: string;
  consent: string;
  pasteLabel: string;
  pastePlaceholder: string;
}> = {
  antigravity: {
    title: 'Add Google Account',
    intro: 'Google OAuth requires a local port redirect. Follow these manual steps to authenticate.',
    button: 'Sign In with Google',
    consent:
      'Log in to your Google Account. Once finished, your browser will attempt to load a failed local URL (e.g. `http://localhost:3000/oauth-callback?code=...`).',
    pasteLabel: 'Paste Redirect URL',
    pastePlaceholder: 'Paste the entire redirected localhost URL here...',
  },
  codex: {
    title: 'Add ChatGPT Account',
    intro: 'Signs in with your ChatGPT subscription. Open the link in a new tab, approve, then paste the URL you land on.',
    button: 'Sign In with ChatGPT',
    consent:
      'OpenAI redirects to `http://localhost:1455/auth/callback`, a port this gateway does not listen on — so the tab will fail to load, which is expected. Copy its full URL and paste it below.',
    pasteLabel: 'Paste Redirect URL',
    pastePlaceholder: 'Paste the entire redirected localhost:1455 URL here...',
  },
  'claudecode': {
    title: 'Add Claude Account',
    intro: 'Signs in with your Claude subscription. Open the link in a new tab, approve, and bring the result back here.',
    button: 'Sign In with Claude',
    consent:
      'Approve in the new tab. If it lands back on this gateway the account is added for you and this dialog closes; if it cannot reach the gateway, copy that tab\'s full URL and paste it below.',
    pasteLabel: 'Paste Redirect URL',
    pastePlaceholder: 'Paste the entire redirected URL, or just the code, here...',
  },
};

/** A provider with no entry gets neutral wording rather than another vendor's. */
const FALLBACK_COPY = {
  title: 'Add Account',
  intro: 'Sign in with the provider, then bring the authorization code back here.',
  button: 'Sign In',
  consent: 'Complete the sign-in. The provider will give you an authorization code.',
  pasteLabel: 'Paste Authorization Code',
  pastePlaceholder: 'Paste the code or the full redirect URL here...',
};

interface Props {
  /**
   * Which provider this is acting on.
   *
   * Passed in rather than named in here: this component serves any provider that declares
   * `accountFlow: 'oauth-redirect'` — Antigravity and Claude Code today — and the codebase has
   * already been burned once by UI that guessed a provider from its id.
   */
  providerId: string;
  accounts: Account[];
  refreshQueries: () => void;
}

export function OAuthAccountsTab({ providerId, accounts, refreshQueries }: Props) {
  const copy = COPY[providerId] ?? FALLBACK_COPY;
  // A Google concept. Antigravity has a cloudaicompanion project to look up; nothing else here does.
  const supportsRediscover = providerId === 'antigravity';
  const [toast, setToast] = useState<string | null>(null);
  const [deleteEmail, setDeleteEmail] = useState<string | null>(null);

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [authUrl, setAuthUrl] = useState('');
  const [pastedUrl, setPastedUrl] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleOpenAuthModal = async () => {
    try {
      const res = await api.post<{ redirectUrl: string }>(`/api/providers/${providerId}/accounts/add`);
      if (res?.redirectUrl) {
        setAuthUrl(res.redirectUrl);
        setPastedUrl('');
        setShowAuthModal(true);
      } else {
        showToast('OAuth flow initialization failed.');
      }
    } catch (err: any) {
      showToast(`Error initializing auth: ${err.message}`);
    }
  };

  /**
   * Close the dialog when the sign-in tab reports it is done.
   *
   * A provider whose `redirect_uri` points back at this gateway — Claude Code does — finishes the
   * exchange server-side, so the operator has nothing left to paste. That tab posts a message on its
   * way out; without listening for it the dialog sits there asking for a URL whose code has already
   * been spent.
   *
   * Only while the dialog is open, and only from this origin: the message is a request to change what
   * is on screen, and any page the operator has open can post one.
   */
  useEffect(() => {
    if (!showAuthModal) return;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'claudecode-oauth-done') return;
      setShowAuthModal(false);
      showToast('Account added successfully!');
      refreshQueries();
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [showAuthModal, refreshQueries]);

  const handleAuthenticate = async () => {
    if (!pastedUrl.trim()) return;
    setIsAuthenticating(true);

    let code = pastedUrl.trim();
    let state: string | undefined;
    try {
      if (code.startsWith('http') || code.includes('?')) {
        const urlObj = new URL(code);
        state = urlObj.searchParams.get('state') || undefined;
        code = urlObj.searchParams.get('code') || code;
      }
    } catch {
      // Ignored
    }

    try {
      const res = await api.post<{ success: boolean; email?: string; error?: string }>(
        `/api/providers/${providerId}/accounts/add`,
        { code, ...(state ? { state } : {}) }
      );
      if (res?.success) {
        showToast(`Account ${res.email || ''} authenticated successfully!`);
        setShowAuthModal(false);
        refreshQueries();
      } else if (res?.error) {
        showToast(`Auth failed: ${res.error}`);
      } else {
        showToast('Authentication failed.');
      }
    } catch (err: any) {
      showToast(`Auth error: ${err.message}`);
    } finally {
      setIsAuthenticating(false);
    }
  };

  const cooldownMutation = useMutation({
    mutationFn: (email: string) => api.post(`/api/providers/${providerId}/accounts/${email}/action`, { action: 'cooldown', payload: { pool: 'cli' } }),
    onSuccess: () => {
      showToast('Cooldown triggered for account!');
      refreshQueries();
    },
    onError: (err: any) => {
      showToast(`Cooldown failed: ${err.message}`);
    },
  });

  const rediscoverMutation = useMutation({
    mutationFn: (email: string) => api.post(`/api/providers/${providerId}/accounts/${email}/action`, { action: 'rediscover_project' }),
    onSuccess: () => {
      showToast('Project rediscovered!');
      refreshQueries();
    },
    onError: (err: any) => {
      showToast(`Rediscovery failed: ${err.message}`);
    },
  });

  const resetMutation = useMutation({
    mutationFn: (email: string) => api.post(`/api/providers/${providerId}/accounts/${email}/action`, { action: 'reset' }),
    onSuccess: () => {
      showToast('Account state reset successfully!');
      refreshQueries();
    },
    onError: (err: any) => {
      showToast(`Reset failed: ${err.message}`);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (email: string) => api.delete(`/api/providers/${providerId}/accounts/${email}`),
    onSuccess: () => {
      showToast('Account deleted successfully!');
      setDeleteEmail(null);
      refreshQueries();
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center px-1 text-base-content">
        <h3 className="text-xs font-bold tracking-wider text-base-content/40 uppercase">
          ACCOUNTS POOL
        </h3>

        <button
          className="btn btn-sm btn-primary rounded-xl font-semibold gap-1.5"
          onClick={handleOpenAuthModal}
          disabled={isAuthenticating}
        >
          {isAuthenticating ? (
            <span className="loading loading-spinner loading-xs" />
          ) : (
            <>
              <Plus className="w-4 h-4" />
              Add Account
            </>
          )}
        </button>
      </div>

      {accounts.length === 0 ? (
        <EmptyState message="No accounts registered for this provider yet. Use the 'Add Account' button to configure one." />
      ) : (
        <>
          <div className="hidden lg:block">
            <AccountsTable
              accounts={accounts}
              onCooldown={(email) => cooldownMutation.mutate(email)}
              {...(supportsRediscover ? { onRediscover: (email: string) => rediscoverMutation.mutate(email) } : {})}
              onReset={(email) => resetMutation.mutate(email)}
              onDelete={(email) => setDeleteEmail(email)}
            />
          </div>

          <div className="block lg:hidden space-y-4">
            {accounts.map((acc) => (
              <AccountCard
                key={acc.email}
                account={acc}
                onCooldown={(email) => cooldownMutation.mutate(email)}
                {...(supportsRediscover ? { onRediscover: (email: string) => rediscoverMutation.mutate(email) } : {})}
                onReset={(email) => resetMutation.mutate(email)}
                onDelete={(email) => setDeleteEmail(email)}
              />
            ))}
          </div>
        </>
      )}

      <ConfirmModal
        isOpen={deleteEmail !== null}
        title="Delete Account?"
        message={`Are you sure you want to delete the account ${deleteEmail}? This action will revoke its access tokens and clear its rotation history.`}
        confirmText="Delete Account"
        isDestructive={true}
        onConfirm={() => deleteEmail && deleteMutation.mutate(deleteEmail)}
        onCancel={() => setDeleteEmail(null)}
      />

      {/* Manual OAuth modal */}
      <dialog className={`modal ${showAuthModal ? 'modal-open' : ''}`} onClose={() => setShowAuthModal(false)}>
        <div className="modal-box rounded-2xl border border-base-300 shadow-xl bg-base-100 max-w-md text-base-content">
          <h3 className="font-extrabold text-lg flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary animate-pulse" />
            {copy.title}
          </h3>
          <p className="text-xs text-base-content/50 mt-1 font-sans">
            {copy.intro}
          </p>

          <div className="mt-5 space-y-4 font-sans">
            <div className="flex gap-3 items-start">
              <span className="badge badge-primary font-bold mt-0.5">1</span>
              <div className="flex-1">
                <span className="text-xs font-bold block mb-1">Authorization Link</span>
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-sm btn-primary rounded-xl font-bold w-full gap-1.5 flex items-center justify-center shadow shadow-primary/20 hover:scale-[1.02] transition-transform"
                >
                  <Plus className="w-4 h-4" />
                  {copy.button}
                </a>
              </div>
            </div>

            <div className="flex gap-3 items-start">
              <span className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-bold mt-0.5">2</span>
              <div className="flex-1">
                <span className="text-xs font-bold block">Complete Consent</span>
                <p className="text-[10px] text-base-content/40 mt-0.5 leading-relaxed">
                  {copy.consent}
                </p>
              </div>
            </div>

            <div className="flex gap-3 items-start">
              <span className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-bold mt-0.5">3</span>
              <div className="flex-1">
                <span className="text-xs font-bold block mb-1">{copy.pasteLabel}</span>
                <textarea
                  className="textarea textarea-bordered bg-base-300 font-mono text-xs w-full h-24 focus:outline-none placeholder-base-content/20 leading-relaxed border-base-300"
                  placeholder={copy.pastePlaceholder}
                  value={pastedUrl}
                  onChange={(e) => setPastedUrl(e.target.value)}
                />
              </div>
            </div>
          </div>

          <div className="modal-action mt-6 gap-2">
            <button
              type="button"
              className="btn btn-sm btn-ghost rounded-xl text-xs font-bold"
              onClick={() => setShowAuthModal(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary rounded-xl text-xs font-bold gap-1"
              onClick={handleAuthenticate}
              disabled={isAuthenticating || !pastedUrl.trim()}
            >
              {isAuthenticating ? (
                <span className="loading loading-spinner loading-xs" />
              ) : (
                'Authenticate'
              )}
            </button>
          </div>
        </div>
        <form method="dialog" className="modal-backdrop">
          <button type="button" onClick={() => setShowAuthModal(false)}>close</button>
        </form>
      </dialog>

      {toast && (
        <div className="toast toast-end toast-bottom z-50">
          <div className="alert alert-info text-xs font-bold shadow-lg rounded-xl">
            <span>{toast}</span>
          </div>
        </div>
      )}
    </div>
  );
}
