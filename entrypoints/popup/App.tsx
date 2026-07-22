import { useCallback, useEffect, useState } from 'react';
import { formatVersionLabel, isUpdateAvailable } from '@/utils/version';
import { fetchLatestRelease } from '@/utils/update';
import { shortenUrl, visibleMedia } from '@/utils/detect';
import { DRM_UNSUPPORTED_ERROR } from '@/utils/drm';
import {
  computeFetchStats,
  formatBytes,
  formatEta,
  formatSpeed,
} from '@/utils/progress';
import {
  DEFAULT_ENABLED_TYPES,
  getDownloads,
  getEnabledTypes,
  getHlsJobs,
  getPreferredHeight,
  getSizeWarnBytes,
  getTabMedia,
  setPreferredHeight,
  type DownloadEntry,
  type EnabledTypes,
  type HlsJob,
  type UpdateCheck,
} from '@/utils/storage';
import {
  requestDownload,
  requestDownloadCancel,
  requestHlsCancel,
  requestHlsDownload,
  requestHlsEstimate,
  requestVariants,
} from '@/utils/messages';
import type { MediaItem, VariantInfo } from '@/utils/types';
import './App.css';

const TYPE_LABEL: Record<MediaItem['type'], string> = {
  hls: 'HLS',
  dash: 'DASH',
  progressive: 'MP4',
  blob: 'BLOB',
  youtube: 'YouTube',
};

function friendlyDownloadError(code?: string): string {
  switch (code) {
    case undefined:
      return 'không rõ';
    case 'SERVER_FORBIDDEN':
      return 'máy chủ từ chối (403)';
    case 'SERVER_UNAUTHORIZED':
      return 'cần xác thực (401)';
    case 'SERVER_BAD_CONTENT':
      return 'nội dung lỗi';
    case 'NETWORK_FAILED':
      return 'lỗi mạng';
    case 'USER_CANCELED':
      return 'đã huỷ';
    default:
      return code;
  }
}

function downloadStatusText(entry: DownloadEntry): string {
  switch (entry.state) {
    case 'in_progress': {
      // W2.5 — progressive fetch in offscreen reports bytes; show % if the total is known, otherwise indeterminate.
      if (entry.bytesTotal && entry.bytesTotal > 0) {
        const pct = Math.min(
          99,
          Math.round(((entry.bytesReceived ?? 0) / entry.bytesTotal) * 100),
        );
        return `Đang tải… ${pct}% (${formatBytes(entry.bytesReceived ?? 0)}/${formatBytes(entry.bytesTotal)})`;
      }
      if (entry.bytesReceived && entry.bytesReceived > 0) {
        return `Đang tải… ${formatBytes(entry.bytesReceived)}`;
      }
      return 'Đang tải…';
    }
    case 'complete':
      return 'Đã tải xong ✓';
    case 'interrupted':
      return `Lỗi: ${friendlyDownloadError(entry.error)}`;
  }
}

/**
 * Banner announcing a new version on GitHub Releases.
 * Cannot self-update (installed via load unpacked) -> just opens the Release page for the user to download manually.
 */
function UpdateBanner({ update }: { update: UpdateCheck }) {
  return (
    <div className="update-banner">
      <span className="update-text">Có bản mới {update.latestTag}</span>
      <button
        type="button"
        className="ghost-btn update-btn"
        onClick={() => void browser.tabs.create({ url: update.releaseUrl })}
      >
        Tải về
      </button>
    </div>
  );
}

/** Renders full HLS progress per phase: label + % + speed + ETA + progress bar. */
function HlsProgress({ job, now }: { job: HlsJob; now: number }) {
  if (job.phase === 'queued') {
    return (
      <div className="hls-progress">
        <span className="hls-label">Đang chờ bộ xử lý nhận việc…</span>
        <div className="progress-bar indeterminate" />
      </div>
    );
  }
  if (job.phase === 'loading') {
    // The label must state EXACTLY what's running: in this phase, offscreen fetches the playlist
    // AND builds the muxer in parallel. The old label only said "loading processor" -> when the
    // playlist hangs, the user would wrongly suspect the muxer instead.
    return (
      <div className="hls-progress">
        <span className="hls-label">
          Đang đọc playlist &amp; nạp bộ xử lý video… (lần đầu hơi lâu)
        </span>
        <div className="progress-bar indeterminate" />
      </div>
    );
  }
  if (job.phase === 'fetching') {
    const s = computeFetchStats({
      segmentsDone: job.segmentsDone,
      segmentsTotal: job.segmentsTotal,
      bytesDownloaded: job.bytesDownloaded ?? 0,
      startedAt: job.startedAt ?? now,
      now,
    });
    return (
      <div className="hls-progress">
        <span className="hls-label">
          Đang tải: {job.segmentsDone}/{job.segmentsTotal} segment · {s.pct}%
          {s.speedBytesPerSec > 0
            ? ` · ${formatSpeed(s.speedBytesPerSec)}`
            : ''}
          {` · còn ${formatEta(s.etaSec)}`}
        </span>
        <div className="progress-bar">
          <div className="progress-fill" style={{ width: `${s.pct}%` }} />
        </div>
        {/* W2.6: flaky network -> the progress bar sits still for a whole minute. Saying nothing
            makes the user think it's stuck and close it themselves. This is a temporary note,
            NOT an error — the job is still running. */}
        {job.note ? <span className="hls-note">{job.note}</span> : null}
      </div>
    );
  }
  if (job.phase === 'muxing') {
    const pct =
      job.muxProgress != null ? Math.round(job.muxProgress * 100) : null;
    return (
      <div className="hls-progress">
        <span className="hls-label">
          Đang ghép video…{pct != null ? ` ${pct}%` : ''}
        </span>
        {pct != null && pct > 0 ? (
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        ) : (
          <div className="progress-bar indeterminate" />
        )}
      </div>
    );
  }
  if (job.phase === 'saving') {
    return (
      <div className="hls-progress">
        <span className="hls-label">Đang lưu file…</span>
        <div className="progress-bar indeterminate" />
      </div>
    );
  }
  if (job.phase === 'done') {
    return <span className="dl-status dl-complete">Đã tải xong ✓</span>;
  }
  if (job.phase === 'cancelled') {
    return <span className="dl-status">Đã huỷ</span>;
  }
  return (
    <span className="dl-status dl-interrupted">
      Lỗi: {job.error ?? 'không rõ'}
    </span>
  );
}

function nearestByHeight(
  variants: VariantInfo[],
  target: number,
): VariantInfo | undefined {
  let best: VariantInfo | undefined;
  let bestDiff = Infinity;
  for (const v of variants) {
    if (v.height == null) continue;
    const diff = Math.abs(v.height - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = v;
    }
  }
  return best ?? variants[0];
}

function MediaRow({
  media,
  tabId,
  download,
  hlsJob,
  now,
}: {
  media: MediaItem;
  tabId: number | null;
  download?: DownloadEntry;
  hlsJob?: HlsJob;
  now: number;
}) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [variants, setVariants] = useState<VariantInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Select by `id`, NOT by `uri`: an Apple master playlist and DASH SegmentTemplate give every
  // variant the same uri -> comparing by uri would light up the whole group on one click.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dlError, setDlError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const canPickQuality = media.type === 'hls' || media.type === 'dash';
  const isProgressive = media.type === 'progressive';
  const isBlob = media.type === 'blob';
  const jobBusy =
    hlsJob?.phase === 'queued' ||
    hlsJob?.phase === 'loading' ||
    hlsJob?.phase === 'fetching' ||
    hlsJob?.phase === 'muxing' ||
    hlsJob?.phase === 'saving';

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(media.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard access may be blocked.
    }
  }, [media.url]);

  const startDownload = useCallback(async () => {
    if (tabId == null) return;
    setDlError(null);
    const res = await requestDownload(media.url, tabId);
    if (!res.ok) setDlError(res.error);
  }, [media.url, tabId]);

  const startHlsDownload = useCallback(
    async (variant: VariantInfo) => {
      if (tabId == null) return;
      setDlError(null);
      // Remove the dead silence: show "Checking…" while estimating (the job doesn't exist yet).
      setChecking(true);
      const audioRendition = variant.audioRenditions?.find((r) => r.selected);
      const audioUri = audioRendition?.uri;
      // W1.5 — DASH identifies a track by id, NOT by uri (every representation shares one .mpd).
      const kind = media.type === 'dash' ? ('dash' as const) : ('hls' as const);
      const variantId = kind === 'dash' ? variant.id : undefined;
      const audioId = kind === 'dash' ? audioRendition?.id : undefined;
      let est: Awaited<ReturnType<typeof requestHlsEstimate>>;
      try {
        est = await requestHlsEstimate(
          variant.uri,
          variant.bandwidth,
          audioUri,
          tabId,
          kind,
          variantId,
          audioId,
        );
      } finally {
        setChecking(false);
      }
      if (!est.ok) {
        setDlError(est.error);
        return;
      }
      if (est.protected) {
        setDlError(DRM_UNSUPPORTED_ERROR(est.drmName));
        return;
      }
      // Merge EVERY warning into EXACTLY ONE dialog: two consecutive confirms and the user just
      // clicks OK out of habit, so the second warning might as well not exist.
      const warnings: string[] = [];
      if (est.estBytes != null) {
        const threshold = await getSizeWarnBytes();
        if (est.estBytes > threshold) {
          warnings.push(
            `Video ước tính ~${formatBytes(est.estBytes)} (${est.segmentCount} segment). ` +
              'Tải & ghép trong bộ nhớ có thể tốn nhiều RAM.',
          );
        }
      }
      // W1.4 — "join point" = a timestamp reset partway through (usually from an ad insertion).
      // We concatenate bytes then remux with `-c copy`, so ffmpeg receives a DTS stream that is
      // NOT monotonic: the file plays fine at the start then goes out of sync/freezes/has a wrong
      // duration — and the 'Non-monotonous DTS' log only lands in console.debug, so the job still
      // reports "Download complete ✓". Better to warn UP FRONT than hand over a broken file with a checkmark.
      if (est.discontinuityCount > 0) {
        warnings.push(
          `Video có ${est.discontinuityCount} chỗ nối giữa chừng (thường do chèn quảng cáo). ` +
            'File ghép ra có thể lệch tiếng, đứng hình hoặc sai thời lượng.',
        );
      }
      if (
        warnings.length > 0 &&
        !window.confirm(`${warnings.join('\n\n')}\n\nVẫn tải?`)
      ) {
        return;
      }
      const res = await requestHlsDownload(
        variant.uri,
        media.url,
        tabId,
        variant.height,
        // W1.1: the separate audio track this variant uses. A missing `uri` means audio is
        // already embedded in the variant (RFC 8216 §4.3.4.2.1) -> send nothing -> offscreen
        // stays on the single-input path.
        audioUri,
        kind,
        variantId,
        audioId,
      );
      if (!res.ok) setDlError(res.error);
    },
    [tabId, media.url, media.type],
  );

  const toggleQuality = useCallback(async () => {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (variants || loading) return;
    if (media.type !== 'hls' && media.type !== 'dash') return;

    setLoading(true);
    setError(null);
    const res = await requestVariants(
      media.url,
      media.type,
      tabId ?? undefined,
    );
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setVariants(res.variants);
    const preferred = await getPreferredHeight();
    const pick =
      preferred != null
        ? nearestByHeight(res.variants, preferred)
        : res.variants[0];
    if (pick) setSelectedId(pick.id);
  }, [open, variants, loading, media.type, media.url, tabId]);

  const chooseVariant = useCallback(async (v: VariantInfo) => {
    setSelectedId(v.id);
    if (v.height) await setPreferredHeight(v.height);
  }, []);

  return (
    <li className="media-item">
      <div className="media-main">
        <span className={`badge badge-${media.type}`}>
          {TYPE_LABEL[media.type]}
        </span>
        <span className="media-url" title={media.url}>
          {shortenUrl(media.url, 36)}
        </span>
        {media.size ? (
          <span className="size-chip">{formatBytes(media.size)}</span>
        ) : null}
        <div className="media-actions">
          {canPickQuality && (
            <button
              type="button"
              className="ghost-btn"
              onClick={() => void toggleQuality()}
            >
              {open ? 'Ẩn' : 'Chất lượng'}
            </button>
          )}
          {isProgressive &&
            (download ? (
              <span className="dl-wrap">
                <span className={`dl-status dl-${download.state}`}>
                  {downloadStatusText(download)}
                </span>
                {download.state === 'in_progress' && (
                  <button
                    type="button"
                    className="ghost-btn danger"
                    onClick={() => void requestDownloadCancel(download.key)}
                  >
                    Hủy
                  </button>
                )}
              </span>
            ) : (
              <button
                type="button"
                className="ghost-btn"
                onClick={() => void startDownload()}
              >
                Tải xuống
              </button>
            ))}
          <button
            type="button"
            className="ghost-btn"
            onClick={() => void copy()}
          >
            {copied ? 'Đã chép' : 'Copy'}
          </button>
        </div>
      </div>

      {isBlob && (
        <p className="hint">
          MSE/blob (player ẩn URL thật) — phát hiện được nhưng chưa hỗ trợ tải
          trực tiếp.
        </p>
      )}

      {media.type === 'youtube' && (
        <p className="hint">
          YouTube — đã phát hiện video tải được (
          {media.youtubeHeights?.[0] ?? '?'}
          p). Nút tải đang được hoàn thiện.
        </p>
      )}

      {/* W1.5 — DASH now REALLY DOWNLOADS (reuses HLS's fetch/mux machinery), so the
          "download not supported yet" hint has been removed. Cases we deliberately don't mux
          (multiple Periods with different init) have offscreen report the specific reason
          right on the job, not a generic sentence here. */}

      {hlsJob && (
        <div className={`dl-hls-${hlsJob.phase}`}>
          <HlsProgress job={hlsJob} now={now} />
          {jobBusy && (
            <button
              type="button"
              className="ghost-btn danger"
              onClick={() => void requestHlsCancel(hlsJob.id)}
            >
              Hủy
            </button>
          )}
        </div>
      )}
      {checking && <p className="muted">Đang kiểm tra dung lượng…</p>}
      {dlError && <p className="error">{dlError}</p>}

      {open && (
        <div className="variants">
          {loading && <p className="muted">Đang tải manifest…</p>}
          {error && <p className="error">{error}</p>}
          {variants && variants.length > 0 && (
            <ul className="variant-list">
              {variants.map((v) => (
                <li key={v.id} className="variant-row">
                  <button
                    type="button"
                    className={`variant-btn${selectedId === v.id ? ' selected' : ''}`}
                    onClick={() => void chooseVariant(v)}
                  >
                    <span className="variant-name">{v.name}</span>
                    {v.bandwidth ? (
                      <span className="muted">
                        {Math.round(v.bandwidth / 1000)} kbps
                      </span>
                    ) : null}
                  </button>
                  {canPickQuality && (
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={jobBusy}
                      onClick={() => void startHlsDownload(v)}
                    >
                      Tải .mp4
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function buildDownloadIndex(
  downloads: Record<string, DownloadEntry>,
): Map<string, DownloadEntry> {
  const byUrl = new Map<string, DownloadEntry>();
  for (const entry of Object.values(downloads)) {
    const cur = byUrl.get(entry.mediaUrl);
    // W2.5: the key is a jobId (string) that isn't order-comparable -> pick the NEWEST entry by
    // startedAt (re-downloading the same URL creates a new entry; we want to show the latest run).
    if (!cur || (entry.startedAt ?? 0) >= (cur.startedAt ?? 0))
      byUrl.set(entry.mediaUrl, entry);
  }
  return byUrl;
}

function buildHlsJobIndex(jobs: Record<string, HlsJob>): Map<string, HlsJob> {
  const byUrl = new Map<string, HlsJob>();
  for (const job of Object.values(jobs)) byUrl.set(job.mediaUrl, job);
  return byUrl;
}

function App() {
  const [version, setVersion] = useState('0.1.0');
  const [tabId, setTabId] = useState<number | null>(null);
  const [items, setItems] = useState<MediaItem[]>([]);
  const [downloads, setDownloads] = useState<Record<string, DownloadEntry>>({});
  const [hlsJobs, setHlsJobs] = useState<Record<string, HlsJob>>({});
  const [enabledTypes, setEnabledTypes] = useState<EnabledTypes>(
    DEFAULT_ENABLED_TYPES,
  );
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  // 1s tick so ETA counts smoothly between storage updates.
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    try {
      const v = browser.runtime.getManifest().version;
      if (v) setVersion(v);
    } catch {
      // outside extension context.
    }
    void (async () => setEnabledTypes(await getEnabledTypes()))();
  }, []);

  // Check for a new version (via a 6h cache). Error -> returns null, no message: it's a secondary feature, don't be noisy.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const info = await fetchLatestRelease();
      if (alive) setUpdate(info);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async (id: number) => {
    const [media, dl, jobs] = await Promise.all([
      getTabMedia(id),
      getDownloads(),
      getHlsJobs(),
    ]);
    setItems(media);
    setDownloads(dl);
    setHlsJobs(jobs);
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [tab] = await browser.tabs.query({
        active: true,
        currentWindow: true,
      });
      const id = tab?.id ?? null;
      if (!alive) return;
      setTabId(id);
      if (id != null) await load(id);
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  useEffect(() => {
    if (tabId == null) return;
    const listener = (_changes: unknown, areaName: string) => {
      if (areaName === 'session') void load(tabId);
    };
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, [tabId, load]);

  const anyJobActive = Object.values(hlsJobs).some(
    (j) =>
      j.phase === 'queued' ||
      j.phase === 'loading' ||
      j.phase === 'fetching' ||
      j.phase === 'muxing' ||
      j.phase === 'saving',
  );
  useEffect(() => {
    if (!anyJobActive) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [anyJobActive]);

  const downloadIndex = buildDownloadIndex(downloads);
  const hlsJobIndex = buildHlsJobIndex(hlsJobs);
  // W4.2 — drop child playlists (video variants / audio renditions of an already-parsed master):
  // one video must be ONE row. The master row still lets you pick any quality, so no functionality is lost.
  const visible = visibleMedia(items).filter((m) => enabledTypes[m.type]);

  return (
    <main className="app">
      <h1 className="title">
        {formatVersionLabel('Your Video Is Mine', version)}
      </h1>
      {update && isUpdateAvailable(update.latestTag, version) && (
        <UpdateBanner update={update} />
      )}
      {visible.length === 0 ? (
        <p className="hint">
          Chưa phát hiện video — thử phát video trên trang rồi mở lại popup.
        </p>
      ) : (
        <ul className="media-list">
          {visible.map((m) => (
            <MediaRow
              key={m.id}
              media={m}
              tabId={tabId}
              download={downloadIndex.get(m.url)}
              hlsJob={hlsJobIndex.get(m.url)}
              now={now}
            />
          ))}
        </ul>
      )}
    </main>
  );
}

export default App;
