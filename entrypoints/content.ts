import { sendRuntimeMessage, type DomMediaCandidate } from '@/utils/messages';

// Content script (isolated world): scans the DOM for <video>/<source>/<audio> with a direct URL,
// and receives MSE signals from mse-hook (MAIN world) then forwards them to background.
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  allFrames: true,
  main() {
    function absolutize(src: string): string {
      try {
        return new URL(src, location.href).href;
      } catch {
        return src;
      }
    }

    function collect(): DomMediaCandidate[] {
      const seen = new Set<string>();
      const out: DomMediaCandidate[] = [];
      const push = (
        raw: string | null | undefined,
        typeHint?: string | null,
      ) => {
        if (!raw) return;
        // blob:/data: -> MSE/blob, handled by mse-hook (skip here).
        if (raw.startsWith('blob:') || raw.startsWith('data:')) return;
        const url = absolutize(raw);
        if (seen.has(url)) return;
        seen.add(url);
        out.push({ url, contentTypeHint: typeHint ?? undefined });
      };

      document.querySelectorAll('video, audio').forEach((el) => {
        const media = el as HTMLMediaElement;
        push(media.currentSrc || media.getAttribute('src'));
      });
      document.querySelectorAll('source').forEach((el) => {
        const source = el as HTMLSourceElement;
        push(source.getAttribute('src'), source.getAttribute('type'));
      });
      return out;
    }

    function report() {
      const candidates = collect();
      if (candidates.length > 0) {
        void sendRuntimeMessage({ kind: 'media/dom', candidates });
      }
    }

    report();

    // Watch for dynamic DOM changes (SPA/player inserting elements late), debounce 500ms to avoid spam.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        report();
      }, 500);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });

    // Receive MSE signals from mse-hook (MAIN world) via window.postMessage.
    window.addEventListener('message', (e: MessageEvent) => {
      // Ignore our own ping (see the handshake below) — otherwise we'd process our own message and,
      // worse, get a postMessage loop.
      if ((e.data as { kind?: string } | null)?.kind === 'isolated-ready')
        return;
      const data = e.data as {
        __yvim?: string;
        kind?: string;
        url?: string;
        mediaType?: string;
        keySystem?: string;
        source?: string;
      } | null;
      if (!data || data.__yvim !== 'yvim-mse') return;
      if (data.kind === 'mse-detected' && typeof data.url === 'string') {
        void sendRuntimeMessage({ kind: 'media/mse', url: data.url });
      }
      // W7.1 — the page requests DRM/EME -> tell background to flag this tab (hard boundary §7).
      if (data.kind === 'drm-detected') {
        void sendRuntimeMessage({
          kind: 'media/drm',
          keySystem: typeof data.keySystem === 'string' ? data.keySystem : '',
        });
      }
      // Disguised HLS/DASH manifest (mse-hook already sniffed it from the body) -> forward to background.
      if (
        data.kind === 'manifest' &&
        typeof data.url === 'string' &&
        (data.mediaType === 'hls' || data.mediaType === 'dash')
      ) {
        void sendRuntimeMessage({
          kind: 'media/manifest',
          url: data.url,
          mediaType: data.mediaType,
        });
      }
    });

    // 🔴 HANDSHAKE WITH THE MAIN WORLD — must be done AFTER the listener above is registered.
    // Reason (measured): this file runs at `document_idle`, while the page calls EME as early as
    // PARSE time. Any DRM signal fired before this point has already fallen into the void. Send a ping so MAIN replays its queue.
    try {
      window.postMessage({ __yvim: 'yvim-mse', kind: 'isolated-ready' }, '*');
    } catch {
      // ignore
    }
  },
});
