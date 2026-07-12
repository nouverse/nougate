import React from 'react';

interface Props {
  score: number;
  className?: string;
}

export function HealthBadge({ score, className = '' }: Props) {
  let badgeClass = 'badge-success';
  if (score < 40) {
    badgeClass = 'badge-error';
  } else if (score < 80) {
    badgeClass = 'badge-warning';
  }

  return (
    <span className={`badge ${badgeClass} badge-sm font-semibold tracking-wide ${className}`}>
      {score}%
    </span>
  );
}
