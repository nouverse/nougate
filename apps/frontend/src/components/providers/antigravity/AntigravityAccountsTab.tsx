import React, { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Account } from '@/lib/types';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { AccountsTable } from './AccountsTable';
import { AccountCard } from './AccountCard';
import { Plus, Shield } from 'lucide-react';

interface Props {
  accounts: Account[];
  refreshQueries: () => void;
}

export function AntigravityAccountsTab({ accounts, refreshQueries }: Props) {
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
      const res = await api.post<{ redirectUrl: string }>(`/api/providers/antigravity/accounts/add`);
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

  const handleAuthenticate = async () => {
    if (!pastedUrl.trim()) return;
    setIsAuthenticating(true);

    let code = pastedUrl.trim();
    try {
      if (code.startsWith('http') || code.includes('?')) {
        const urlObj = new URL(code);
        code = urlObj.searchParams.get('code') || code;
      }
    } catch {
      // Ignored
    }

    try {
      const res = await api.post<{ success: boolean; email?: string; error?: string }>(
        `/api/providers/antigravity/accounts/add`,
        { code }
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
    mutationFn: (email: string) => api.post(`/api/accounts/${email}/cooldown`, { pool: 'cli' }),
    onSuccess: () => {
      showToast('Cooldown triggered for account!');
      refreshQueries();
    },
  });

  const rediscoverMutation = useMutation({
    mutationFn: (email: string) => api.post(`/api/accounts/${email}/project/rediscover`),
    onSuccess: () => {
      showToast('Project rediscovered!');
      refreshQueries();
    },
    onError: (err: any) => {
      showToast(`Rediscovery failed: ${err.message}`);
    },
  });

  const resetMutation = useMutation({
    mutationFn: (email: string) => api.post(`/api/accounts/${email}/reset`),
    onSuccess: () => {
      showToast('Account state reset successfully!');
      refreshQueries();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (email: string) => api.delete(`/api/accounts/${email}`),
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
              onRediscover={(email) => rediscoverMutation.mutate(email)}
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
                onRediscover={(email) => rediscoverMutation.mutate(email)}
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
            Add Google Account
          </h3>
          <p className="text-xs text-base-content/50 mt-1 font-sans">
            Google OAuth requires a local port redirect. Follow these manual steps to authenticate.
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
                  Sign In with Google
                </a>
              </div>
            </div>

            <div className="flex gap-3 items-start">
              <span className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-bold mt-0.5">2</span>
              <div className="flex-1">
                <span className="text-xs font-bold block">Complete Consent</span>
                <p className="text-[10px] text-base-content/40 mt-0.5 leading-relaxed">
                  Log in to your Google Account. Once finished, your browser will attempt to load a failed local URL (e.g. `http://localhost:3000/oauth-callback?code=...`).
                </p>
              </div>
            </div>

            <div className="flex gap-3 items-start">
              <span className="badge badge-neutral bg-base-300 text-base-content/75 border-0 font-bold mt-0.5">3</span>
              <div className="flex-1">
                <span className="text-xs font-bold block mb-1">Paste Redirect URL</span>
                <textarea
                  className="textarea textarea-bordered bg-base-300 font-mono text-xs w-full h-24 focus:outline-none placeholder-base-content/20 leading-relaxed border-base-300"
                  placeholder="Paste the entire redirected localhost URL here..."
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
