import React, { useState, useEffect, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Account } from '@/lib/types';
import { EmptyState } from '@/components/shared/EmptyState';
import { ConfirmModal } from '@/components/shared/ConfirmModal';
import { AccountsTable } from './AccountsTable';
import { AccountCard } from './AccountCard';
import { Plus, Shield } from 'lucide-react';

interface Props {
  providerId: string;
  displayName: string;
  accounts: Account[];
  refreshQueries: () => void;
}

/**
 * Accounts tab for any provider declaring `accountFlow: 'device-code'`.
 *
 * The provider answers an empty add-account body with a device code, is polled through
 * `/api/providers/:id/device-status`, and takes a pasted credential as `{ token }`. Nothing here
 * knows which provider it is talking to beyond the id and the name it displays.
 */
export function DeviceCodeAccountsTab({ providerId, displayName, accounts, refreshQueries }: Props) {
  const base = `/api/providers/${encodeURIComponent(providerId)}`;
  const [toast, setToast] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const [showAuthModal, setShowAuthModal] = useState(false);
  const [deviceFlowData, setDeviceFlowData] = useState<any>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [pastedUrl, setPastedUrl] = useState('');
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const [isVerifying, setIsVerifying] = useState(false);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  };

  const handleCloseAuthModal = () => {
    setShowAuthModal(false);
    setDeviceFlowData(null);
    setAuthError(null);
    setPastedUrl('');
  };

  const handleVerifyDeviceLogin = async () => {
    if (!deviceFlowData) return;
    setIsVerifying(true);
    setAuthError(null);

    try {
      const res = await api.get<{ status: string; error?: string; account?: any }>(
        `${base}/device-status?device_code=${encodeURIComponent(deviceFlowData.device_code)}`
      );

      if (res?.status === 'success') {
        showToast(`Account ${res.account?.email || ''} added successfully!`);
        setShowAuthModal(false);
        setDeviceFlowData(null);
        refreshQueries();
      } else if (res?.status === 'pending') {
        setAuthError('Sign-in is still pending. Approve the activation code in your browser first, then verify again.');
      } else {
        setAuthError(res.error || 'Device flow expired or failed.');
      }
    } catch (err: any) {
      setAuthError(err.message || 'Failed to verify authentication.');
    } finally {
      setIsVerifying(false);
    }
  };

  const handleOpenAuthModal = async () => {
    try {
      setAuthError(null);
      setDeviceFlowData(null);
      setPastedUrl('');
      setIsAuthenticating(true);

      const res = await api.post<any>(`${base}/accounts/add`, {});
      if (res?.step === 'device_flow') {
        setDeviceFlowData(res);
        setShowAuthModal(true);
      } else {
        showToast('Device flow initialization failed.');
      }
    } catch (err: any) {
      showToast(`Error initializing auth: ${err.message}`);
    } finally {
      setIsAuthenticating(false);
    }
  };

  const handleAuthenticate = async () => {
    if (!pastedUrl.trim()) return;
    setIsAuthenticating(true);

    try {
      const res = await api.post<any>(
        `${base}/accounts/add`,
        { token: pastedUrl.trim() }
      );

      if (res?.id) {
        showToast(`Account ${res.email || ''} authenticated successfully!`);
        handleCloseAuthModal();
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
    mutationFn: (id: string) => api.post(`${base}/accounts/${encodeURIComponent(id)}/action`, { action: 'cooldown', payload: { pool: 'cli' } }),
    onSuccess: () => {
      showToast('Cooldown triggered for account!');
      refreshQueries();
    },
  });

  const resetMutation = useMutation({
    mutationFn: (id: string) => api.post(`${base}/accounts/${encodeURIComponent(id)}/action`, { action: 'reset' }),
    onSuccess: () => {
      showToast('Account state reset successfully!');
      refreshQueries();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`${base}/accounts/${encodeURIComponent(id)}`),
    onSuccess: () => {
      showToast('Account deleted successfully!');
      setDeleteId(null);
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
              onCooldown={(id) => cooldownMutation.mutate(id)}
              onReset={(id) => resetMutation.mutate(id)}
              onDelete={(id) => setDeleteId(id)}
            />
          </div>

          <div className="block lg:hidden space-y-4">
            {accounts.map((acc) => (
              <AccountCard
                key={acc.id}
                account={acc}
                onCooldown={(id) => cooldownMutation.mutate(id)}
                onReset={(id) => resetMutation.mutate(id)}
                onDelete={(id) => setDeleteId(id)}
              />
            ))}
          </div>
        </>
      )}

      <ConfirmModal
        isOpen={deleteId !== null}
        title="Delete Account?"
        message={`Are you sure you want to delete the account ${
          accounts.find((acc) => acc.id === deleteId)?.email || deleteId
        }? This action will revoke its access tokens and clear its rotation history.`}
        confirmText="Delete Account"
        isDestructive={true}
        onConfirm={() => deleteId && deleteMutation.mutate(deleteId)}
        onCancel={() => setDeleteId(null)}
      />

      {/* Device Flow modal */}
      <dialog className={`modal ${showAuthModal ? 'modal-open' : ''}`} onClose={handleCloseAuthModal}>
        <div className="modal-box rounded-2xl border border-base-300 shadow-xl bg-base-100 max-w-md text-base-content">
          <h3 className="font-extrabold text-lg flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary animate-pulse" />
            Add {displayName} Account
          </h3>
          <p className="text-xs text-base-content/50 mt-1 font-sans">
            Sign in with a device code, or paste a credential manually.
          </p>

          <div className="mt-5 space-y-5 font-sans">
            {deviceFlowData && (
              <div className="bg-base-200 p-4 rounded-xl border border-base-300 space-y-3">
                <div className="text-center space-y-1">
                  <span className="text-[10px] text-base-content/40 font-bold uppercase tracking-wider">Activation Code</span>
                  <div className="text-2xl font-mono font-black text-primary tracking-widest bg-base-300 py-2 px-4 rounded-lg select-all border border-base-300">
                    {deviceFlowData.user_code}
                  </div>
                </div>

                <a
                  href={deviceFlowData.verification_uri_complete || deviceFlowData.verification_uri}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn-sm btn-primary rounded-xl font-bold w-full gap-1.5 flex items-center justify-center shadow shadow-primary/20 hover:scale-[1.02] transition-transform mt-2"
                >
                  1. Open Activation Page ↗
                </a>
                <p className="text-[10px] text-base-content/50 text-center leading-relaxed">
                  Click the button above and paste the activation code.
                </p>

                <button
                  type="button"
                  className="btn btn-sm btn-secondary rounded-xl font-bold w-full gap-1.5 flex items-center justify-center shadow mt-2"
                  onClick={handleVerifyDeviceLogin}
                  disabled={isVerifying}
                >
                  {isVerifying ? (
                    <span className="loading loading-spinner loading-xs" />
                  ) : (
                    '2. Verify Activation'
                  )}
                </button>
              </div>
            )}

            {authError && (
              <div className="alert alert-error text-xs font-semibold py-2.5 rounded-xl shadow">
                <span>{authError}</span>
              </div>
            )}

            <div className="border-t border-base-300 pt-4 space-y-3">
              <span className="text-xs font-bold block mb-1 text-base-content/75">Or paste a token manually:</span>
              <textarea
                className="textarea textarea-bordered bg-base-300 font-mono text-xs w-full h-24 focus:outline-none placeholder-base-content/30 leading-relaxed border-base-300"
                placeholder="Paste a token here"
                value={pastedUrl}
                onChange={(e) => setPastedUrl(e.target.value)}
              />
            </div>
          </div>

          <div className="modal-action mt-6 gap-2">
            <button
              type="button"
              className="btn btn-sm btn-ghost rounded-xl text-xs font-bold"
              onClick={handleCloseAuthModal}
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
          <button type="button" onClick={handleCloseAuthModal}>close</button>
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
