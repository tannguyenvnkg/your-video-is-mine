import { removeOpfsFile } from './libav-mux';

// blob URLs currently held (revoked once background reports the download finished, or after a
// fallback timeout).
export const activeBlobUrls = new Set<string>();
export const BLOB_TTL_MS = 10 * 60 * 1000;

/**
 * blob URL -> the OPFS filename backing it.
 *
 * 🔴 DO NOT delete the OPFS file right after sending `download/blob`: background handles that
 * message fire-and-forget (`background.ts:405-416` returns `undefined`, no ACK), so offscreen has
 * NO WAY to know whether `chrome.downloads.download()` has actually been called yet. MEASURED: it's
 * absolutely safe to delete AFTER `download()` returns an id (the download completes with full bytes
 * even if the file is deleted, offscreen is killed, or the whole extension is reloaded mid-flight) —
 * but "after it returns an id" is a milestone only background can see. So instead hook into a signal
 * that already exists in the protocol: background sends `revoke` when the download finishes. Plus a
 * TTL deadline and a startup sweep so a file can never leak forever.
 */
export const opfsByBlobUrl = new Map<string, string>();

export function revokeBlob(url: string): void {
  if (activeBlobUrls.has(url)) {
    URL.revokeObjectURL(url);
    activeBlobUrls.delete(url);
  }
  // By this point the download has ended (background reported revoke) or the TTL has expired ->
  // delete the OPFS file. MEASURED: deleting the file while `chrome.downloads` is still reading it
  // STILL finishes with the full byte count (POSIX-style unlink semantics), so there's no dangerous
  // window here.
  const opfsName = opfsByBlobUrl.get(url);
  if (opfsName !== undefined) {
    opfsByBlobUrl.delete(url);
    void removeOpfsFile(opfsName);
  }
}
