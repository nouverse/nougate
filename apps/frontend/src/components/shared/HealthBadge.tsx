import React from 'react';

interface Props {
  score: number;
  className?: string;
}

export function HealthBadge({ score, className = '' }: Props) {
  const percent = Math.round(score);

  let badgeClass = 'badge-success';
  if (percent < 40) {
    badgeClass = 'badge-error';
  } else if (percent < 80) {
    badgeClass = 'badge-warning';
  }

  return (
    <span className={`badge ${badgeClass} badge-sm font-semibold tracking-wide ${className}`}>
      {percent}%
    </span>
  );
}
