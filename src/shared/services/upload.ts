/** Real upload percentage from measured bytes. Pure + unit tested. */
export function computeUploadPercent(loaded: number, total: number): number {
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
}

export interface UploadResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

/**
 * POSTs a multipart FormData with real upload-progress reporting via XHR.
 * onProgress receives the actual bytes-uploaded percentage (0–100). After the
 * upload completes the server may still be processing — callers should show a
 * processing state once 100% is reached.
 */
export function uploadWithProgress<T = unknown>(
  url: string,
  formData: FormData,
  onProgress: (percent: number) => void,
): Promise<UploadResult<T>> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(computeUploadPercent(e.loaded, e.total));
    };
    xhr.upload.onload = () => onProgress(100);
    xhr.onload = () => {
      let data: T | null = null;
      try {
        data = JSON.parse(xhr.responseText) as T;
      } catch {
        data = null;
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => resolve({ ok: false, status: 0, data: null });
    xhr.send(formData);
  });
}
