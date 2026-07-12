import React from 'react';

interface Props {
  message?: string;
}

export function EmptyState({ message = 'No data available.' }: Props) {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center bg-base-200/50 rounded-xl border border-dashed border-base-300">
      <p className="text-base-content/50 text-sm font-medium">{message}</p>
    </div>
  );
}
