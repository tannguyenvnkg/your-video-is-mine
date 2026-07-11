import { sendRuntimeMessage, type DomMediaCandidate } from '@/utils/messages';

// Content script (isolated world): quét DOM tìm <video>/<source>/<audio> có URL trực tiếp,
// và nhận tín hiệu MSE từ mse-hook (MAIN world) rồi forward tới background.
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
        // blob:/data: -> MSE/blob, do mse-hook xử lý (bỏ qua tại đây).
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

    // Theo dõi DOM động (SPA/player chèn muộn), debounce 500ms tránh spam.
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

    // Nhận tín hiệu MSE từ mse-hook (MAIN world) qua window.postMessage.
    window.addEventListener('message', (e: MessageEvent) => {
      const data = e.data as {
        __yvim?: string;
        kind?: string;
        url?: string;
      } | null;
      if (!data || data.__yvim !== 'yvim-mse') return;
      if (data.kind === 'mse-detected' && typeof data.url === 'string') {
        void sendRuntimeMessage({ kind: 'media/mse', url: data.url });
      }
    });
  },
});
