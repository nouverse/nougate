import React from 'react';

interface Props {
  isOpen: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
}

export function ConfirmModal({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  isDestructive = false,
}: Props) {
  if (!isOpen) return null;

  return (
    <div className="modal modal-open">
      <div className="modal-box border border-base-300 shadow-2xl">
        <h3 className="font-bold text-lg text-base-content">{title}</h3>
        <p className="py-4 text-sm text-base-content/75">{message}</p>
        <div className="modal-action">
          <button className="btn btn-sm btn-ghost" onClick={onCancel}>
            {cancelText}
          </button>
          <button
            className={`btn btn-sm ${isDestructive ? 'btn-error' : 'btn-primary'}`}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
      <div className="modal-backdrop bg-black/60 backdrop-blur-sm" onClick={onCancel}></div>
    </div>
  );
}
