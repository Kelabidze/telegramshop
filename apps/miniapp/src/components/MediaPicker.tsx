import { useRef, useState } from 'react';
import {
  ACCEPTED_MEDIA_MIME_TYPES,
  MEDIA_DIMENSIONS,
  MEDIA_FORMATS,
  formatBytes,
} from '@shop/shared';
import { ApiError, api } from '../api/client.ts';
import { haptic } from '../telegram/webapp.ts';

/**
 * Media picker for the admin forms.
 *
 * Uploads immediately on pick and hands back the stored URL, rather than
 * deferring to form submit: the file has to reach the server before the record
 * can reference it, and a "save" that uploads 5 MB behind a spinner with no
 * progress feels broken.
 *
 * The size check runs here as well as on the server. Client-side it is a
 * courtesy — refusing a 12 MB GIF instantly beats spending a minute of mobile
 * data to be told no. Server-side it is the actual rule.
 */
export function MediaPicker({
  value,
  onChange,
  shape,
}: {
  value: string | null;
  onChange: (url: string | null) => void;
  /** Which recommended dimensions to advertise. */
  shape: 'banner' | 'product';
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dimensions = MEDIA_DIMENSIONS[shape];

  async function upload(file: File) {
    setError(null);

    const format = MEDIA_FORMATS[file.type];
    if (!format) {
      setError('Допустимы JPEG, PNG, WebP и GIF.');
      return;
    }
    if (file.size > format.maxBytes) {
      setError(
        `Файл ${formatBytes(file.size)} — больше лимита ` +
          `${formatBytes(format.maxBytes)} для ${file.type}.`,
      );
      return;
    }

    setBusy(true);
    try {
      const asset = await api.uploadMedia(file);
      haptic('success');
      onChange(asset.url);
    } catch (err) {
      haptic('error');
      setError(
        err instanceof ApiError ? err.message : 'Не удалось загрузить файл.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      <span className="hint">
        Медиа {dimensions.ratio} ({dimensions.width}×{dimensions.height}).
        JPEG, PNG, WebP до {formatBytes(MEDIA_FORMATS['image/jpeg']!.maxBytes)},
        GIF до {formatBytes(MEDIA_FORMATS['image/gif']!.maxBytes)}.
      </span>

      {value ? (
        <div className="media-preview">
          <img className="media-preview__image" src={value} alt="" />
          <button
            type="button"
            className="button button--danger"
            onClick={() => {
              haptic('tap');
              // The file itself is left on disk on purpose: another record may
              // reference the same URL, and deleting it here would blank their
              // artwork too. Unused files are cleaned up deliberately, from the
              // storage screen.
              onChange(null);
            }}
          >
            Убрать
          </button>
        </div>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_MEDIA_MIME_TYPES.join(',')}
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so picking the same file twice still fires a change event.
          event.target.value = '';
          if (file) void upload(file);
        }}
      />

      <button
        type="button"
        className="button button--secondary"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Загружаем…' : value ? 'Заменить файл' : 'Загрузить файл'}
      </button>

      {error ? (
        <p
          className="hint"
          style={{ margin: 0, color: 'var(--tg-destructive-text-color)' }}
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
