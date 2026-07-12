import React, { useState, useEffect } from 'react';

interface Props {
  value: Record<string, any>;
  onSave: (value: Record<string, any>) => void;
  isSaving?: boolean;
}

export function JsonEditor({ value, onSave, isSaving = false }: Props) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(value, null, 2));
    setError(null);
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    try {
      if (val.trim()) {
        JSON.parse(val);
      }
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Invalid JSON');
    }
  };

  const handleSave = () => {
    try {
      const parsed = JSON.parse(text);
      onSave(parsed);
    } catch (err: any) {
      setError(err.message || 'Invalid JSON');
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <textarea
          className={`textarea textarea-bordered font-mono text-xs w-full h-96 bg-neutral text-neutral-content leading-relaxed focus:outline-none ${
            error ? 'textarea-error border-error' : 'border-base-300'
          }`}
          value={text}
          onChange={handleChange}
        />
        {error && (
          <div className="text-error text-xs font-semibold mt-1 px-1 bg-error/10 border border-error/25 p-2 rounded">
            ⚠️ {error}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button
          className="btn btn-sm btn-primary"
          onClick={handleSave}
          disabled={!!error || isSaving}
        >
          {isSaving ? <span className="loading loading-spinner loading-xs" /> : 'Save Changes'}
        </button>
      </div>
    </div>
  );
}
