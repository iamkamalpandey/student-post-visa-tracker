// Authenticated blob downloads.
// Anchors with `download=` only work for unauthenticated URLs; for endpoints behind a
// Bearer token we fetch the response, materialise an object URL, and synthesise the click.

import { api } from './api';

export async function downloadAuthed(
  url: string,
  filename: string,
  opts: { method?: 'GET' | 'POST'; body?: unknown; query?: Record<string, string> } = {},
): Promise<void> {
  const search = opts.query
    ? '?' + new URLSearchParams(opts.query).toString()
    : '';
  const res = await api.request<Blob>({
    url: `${url}${search}`,
    method: opts.method ?? 'GET',
    responseType: 'blob',
    ...(opts.body !== undefined ? { data: opts.body } : {}),
  });
  const blob = res.data instanceof Blob ? res.data : new Blob([res.data as unknown as BlobPart]);
  const objectUrl = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke after the click handler runs; small delay so the browser can begin the download.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }
}

/** Best-effort filename extraction from a Content-Disposition header. */
export function filenameFromDisposition(header: string | null | undefined, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*=(?:UTF-8''|"?)([^";]+)"?/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!);
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1]! : fallback;
}
