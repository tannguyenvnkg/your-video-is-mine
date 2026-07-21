// Content script running in the MAIN world (page context) to access the REAL window.MediaSource.
// Purpose:
//  - Detect custom-built MSE/blob players (real URL hidden) via a URL.createObjectURL(MediaSource) hook.
//  - Bypass UI blocking: restore right-click / text selection / drag blocked by the page.
// Does NOT use chrome API here (not available in the MAIN world) -> reports back to the isolated
// content script via window.postMessage; isolated forwards it to background.
//
// Note: this is DETECTION only. Reconstructing the stream from appendBuffer (capturing every byte)
// is heavy and fragile -> deferred for later; here we only signal so the user knows the page uses MSE.

export default defineContentScript({
  matches: ['<all_urls>'],
  world: 'MAIN',
  runAt: 'document_start',
  allFrames: true,
  main() {
    const TAG = 'yvim-mse';
    const post = (payload: Record<string, unknown>) => {
      try {
        window.postMessage({ __yvim: TAG, ...payload }, '*');
      } catch {
        // ignore
      }
    };

    // Hook URL.createObjectURL: catch blob URLs created from MediaSource (an MSE player signal).
    try {
      const orig = URL.createObjectURL.bind(URL);
      URL.createObjectURL = ((
        obj: MediaSource | Blob | MediaStream,
      ): string => {
        const url = orig(obj as Blob);
        try {
          if (
            typeof MediaSource !== 'undefined' &&
            obj instanceof MediaSource
          ) {
            post({ kind: 'mse-detected', url });
          }
        } catch {
          // ignore
        }
        return url;
      }) as typeof URL.createObjectURL;
    } catch {
      // ignore
    }

    // ---- W7.1: DRM/EME DETECTION — hard boundary §7 ----
    //
    // 🔴 THIS IS REFUSAL CODE, NOT DECRYPTION CODE. We ONLY listen for whether the page requests
    // DRM, so we can say "not supported" IMMEDIATELY instead of letting the user click download and
    // hit a confusing failure. Never extend this into a key-extraction path — that would be
    // circumventing a technical protection measure, exactly what §7 forbids.
    //
    // Two signals, caught both because they complement each other:
    //  - `requestMediaKeySystemAccess`: the page REQUESTS DRM (we learn the EXACT vendor: Widevine/PlayReady/…)
    //  - the `'encrypted'` event: the stream HAS DRM init data (caught even when the page requested
    //    it before the hook managed to install, e.g. a player loading early in an iframe/worker).
    // 🔴 MUST BE BUFFERED, NOT FIRE-AND-FORGET — MEASURED: the page calls EME during PARSE
    // (document_start), while the isolated content script (the receiver) runs at `document_idle`,
    // i.e. LATER. Firing directly means `postMessage` lands while nobody is listening yet -> the DRM
    // signal is lost entirely, silently breaching the §7 boundary. (Measured symptom: the hook WAS
    // installed — visible as a wrapper in `navigator.…toString()` — yet the tab's `drmSystems`
    // stayed empty.)
    const pendingDrm: Array<{ keySystem: string; source: string }> = [];
    const reportDrm = (keySystem: string, source: string) => {
      pendingDrm.push({ keySystem, source });
      post({ kind: 'drm-detected', keySystem, source });
    };

    // Handshake: as soon as isolated starts up it pings over here, and we REPLAY everything caught
    // so far. A handshake is far more deterministic than a timing trick (any timer delay is just a guess).
    window.addEventListener('message', (e: MessageEvent) => {
      const d = e.data as { __yvim?: string; kind?: string } | null;
      if (!d || d.__yvim !== TAG || d.kind !== 'isolated-ready') return;
      for (const p of pendingDrm) {
        post({
          kind: 'drm-detected',
          keySystem: p.keySystem,
          source: p.source,
        });
      }
    });

    try {
      // The cast at the end is REQUIRED: TS describes `requestMediaKeySystemAccess` via overloads,
      // so a wrapper with a matching runtime signature still can't be assigned directly.
      const nav = navigator;
      const origRMKSA = nav.requestMediaKeySystemAccess?.bind(navigator);
      if (origRMKSA) {
        nav.requestMediaKeySystemAccess = ((
          keySystem: string,
          configs: MediaKeySystemConfiguration[],
        ) => {
          // Report BEFORE calling through: even if the page's permission request gets denied, its intent is already clear.
          try {
            reportDrm(String(keySystem), 'requestMediaKeySystemAccess');
          } catch {
            // ignore
          }
          // Do NOT block, do NOT modify the result: the page still plays video normally as if the extension weren't there.
          // We only refuse to DOWNLOAD, not break the user's viewing experience.
          return origRMKSA(keySystem, configs);
        }) as typeof navigator.requestMediaKeySystemAccess;
      }
    } catch {
      // ignore
    }

    // The 'encrypted' event fires on the media element itself when the stream has PSSH/init data.
    try {
      document.addEventListener(
        'encrypted',
        (e: Event) => {
          const ks = (e as Event & { initDataType?: string }).initDataType;
          // No system name available here (only initDataType like 'cenc'/'keyids'/'webm') -> report
          // an empty string, the receiver will interpret it as "DRM, vendor unknown".
          reportDrm('', `encrypted:${ks ?? '?'}`);
        },
        true, // capture: also catches when the event fires on a deeply nested <video>
      );
    } catch {
      // ignore
    }

    // ---- Sniff disguised HLS/DASH manifests (fake URL/extension/Content-Type) ----
    // MV3 webRequest CANNOT read the body -> blind to manifests with a fake extension (.jpg) / fake
    // Content-Type. But the player ALWAYS has to fetch a playlist starting with "#EXTM3U" (HLS) or
    // "<MPD" (DASH).
    // => Hook fetch/XHR, read the FIRST ~256 bytes of the response to identify it, then report the
    // real URL back to isolated.
    const seen = new Set<string>();

    // Identify the manifest type from the start of the content (truncated to ~256 characters).
    const sniffManifest = (head: string): 'hls' | 'dash' | null => {
      const s = head.trimStart();
      if (s.startsWith('#EXTM3U')) return 'hls';
      // DASH: an XML document with an <MPD> root element.
      if (
        (s.startsWith('<?xml') || s.startsWith('<MPD')) &&
        s.includes('MPD')
      ) {
        return 'dash';
      }
      return null;
    };

    // Report a manifest (deduped by absolute URL).
    const reportManifest = (rawUrl: string, mediaType: 'hls' | 'dash') => {
      try {
        const url = new URL(rawUrl, location.href).href;
        if (seen.has(url)) return;
        seen.add(url);
        post({ kind: 'manifest', url, mediaType });
      } catch {
        // ignore
      }
    };

    // Hook window.fetch: clone the response, read the FIRST CHUNK then cancel (doesn't consume the player's body).
    try {
      const origFetch = window.fetch.bind(window);
      window.fetch = (async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const res = await origFetch(input, init);
        try {
          const reqUrl =
            typeof input === 'string'
              ? input
              : input instanceof URL
                ? input.href
                : input.url;
          if (reqUrl && res.body) {
            const clone = res.clone();
            // Fire-and-forget: does NOT block the response returned to the player.
            void (async () => {
              try {
                const reader = clone.body?.getReader();
                if (!reader) return;
                const { value } = await reader.read();
                void reader.cancel();
                if (value && value.byteLength > 0) {
                  const head = new TextDecoder().decode(value.subarray(0, 256));
                  const t = sniffManifest(head);
                  if (t) reportManifest(reqUrl, t);
                }
              } catch {
                // ignore
              }
            })();
          }
        } catch {
          // ignore
        }
        return res;
      }) as typeof window.fetch;
    } catch {
      // ignore
    }

    // Hook XMLHttpRequest: save the URL at open(), check the first 256 characters of responseText on load.
    try {
      const XHRProto = XMLHttpRequest.prototype;
      const origOpen = XHRProto.open;
      XHRProto.open = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        isAsync?: boolean,
        username?: string | null,
        password?: string | null,
      ) {
        try {
          (this as XMLHttpRequest & { __yvimUrl?: string }).__yvimUrl =
            typeof url === 'string' ? url : url.href;
        } catch {
          // ignore
        }
        // Default async = true (matches real XHR behavior when the parameter is omitted).
        return origOpen.call(
          this,
          method,
          url,
          isAsync ?? true,
          username,
          password,
        );
      } as typeof XHRProto.open;

      const origSend = XHRProto.send;
      XHRProto.send = function (
        this: XMLHttpRequest,
        body?: Document | XMLHttpRequestBodyInit | null,
      ) {
        try {
          this.addEventListener('load', () => {
            try {
              // responseText is only readable when responseType is '' or 'text'.
              if (this.responseType === '' || this.responseType === 'text') {
                const text = this.responseText;
                if (text) {
                  const u = (this as XMLHttpRequest & { __yvimUrl?: string })
                    .__yvimUrl;
                  const t = sniffManifest(text.slice(0, 256));
                  if (t && u) reportManifest(u, t);
                }
              }
            } catch {
              // ignore
            }
          });
        } catch {
          // ignore
        }
        return origSend.call(this, body);
      } as typeof XHRProto.send;
    } catch {
      // ignore
    }

    // Bypass UI blocking: restore right-click + text selection blocked by the page.
    // ONLY contextmenu + selectstart (does NOT touch copy/dragstart, to avoid breaking non-video apps).
    const reenable = (e: Event) => {
      e.stopImmediatePropagation();
    };
    for (const ev of ['contextmenu', 'selectstart']) {
      window.addEventListener(ev, reenable, true);
    }
  },
});
