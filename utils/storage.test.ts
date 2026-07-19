import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  addTabMedia,
  allocateSpoofRuleId,
  clearTabMedia,
  getDownloadByChromeId,
  getDownloads,
  getFilenameTemplate,
  getPreferredHeight,
  getTabMedia,
  getTabState,
  getHlsJobs,
  putDownload,
  putHlsJob,
  resetTab,
  setFilenameTemplate,
  setPreferredHeight,
  setTabNavUrl,
  updateDownload,
  updateHlsJob,
  type HlsJob,
} from './storage';
import { SPOOF_RULE_ID_MIN, SPOOF_RULE_ID_SPAN } from './dnr';
import type { MediaItem } from './types';

function item(url: string, extra: Partial<MediaItem> = {}): MediaItem {
  return { id: url, type: 'hls', url, tabId: 1, detectedAt: 0, ...extra };
}

describe('storage media theo tab', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('tab rỗng trả []', async () => {
    expect(await getTabMedia(1)).toEqual([]);
  });

  it('thêm & đọc lại', async () => {
    const n = await addTabMedia(1, item('https://a.com/x.m3u8'));
    expect(n).toBe(1);
    expect(await getTabMedia(1)).toHaveLength(1);
  });

  it('trùng url không có field mới -> null, không tăng', async () => {
    await addTabMedia(1, item('https://a.com/x.m3u8'));
    const dup = await addTabMedia(1, item('https://a.com/x.m3u8'));
    expect(dup).toBeNull();
    expect(await getTabMedia(1)).toHaveLength(1);
  });

  it('bổ sung size khi phát hiện lại cùng url (merge)', async () => {
    await addTabMedia(1, item('https://a.com/x.m3u8')); // chưa có size
    const changed = await addTabMedia(
      1,
      item('https://a.com/x.m3u8', { size: 999 }),
    );
    expect(changed).toBe(1); // có thay đổi -> trả count
    const list = await getTabMedia(1);
    expect(list[0]!.size).toBe(999);
  });

  it('media các tab độc lập', async () => {
    await addTabMedia(1, item('https://a.com/1.m3u8'));
    await addTabMedia(2, item('https://a.com/2.m3u8'));
    expect(await getTabMedia(1)).toHaveLength(1);
    expect(await getTabMedia(2)).toHaveLength(1);
  });

  it('reset điều hướng: loại media của request cũ (timeStamp < navStartedAt)', async () => {
    await resetTab(1, 1000); // điều hướng lúc t=1000
    const stale = await addTabMedia(1, item('https://a.com/old.m3u8'), 500);
    expect(stale).toBeNull(); // request bắt đầu t=500 < 1000 -> bỏ
    const fresh = await addTabMedia(1, item('https://a.com/new.m3u8'), 1500);
    expect(fresh).toBe(1); // request t=1500 > 1000 -> nhận
    expect(await getTabMedia(1)).toHaveLength(1);
  });

  it('clear xoá danh sách của tab', async () => {
    await addTabMedia(1, item('https://a.com/x.m3u8'));
    await clearTabMedia(1);
    expect(await getTabMedia(1)).toEqual([]);
  });
});

describe('cài đặt preferredHeight (local)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('mặc định null, set rồi get lại', async () => {
    expect(await getPreferredHeight()).toBeNull();
    await setPreferredHeight(720);
    expect(await getPreferredHeight()).toBe(720);
  });
});

describe('allocateSpoofRuleId (id rule DNR theo từng download — W2.4)', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('mỗi lần cấp một id KHÁC NHAU, đều >= ngưỡng dải spoof', async () => {
    // §2.10: id cũ = hash(host) nên hai download cùng CDN trùng id -> giật rule của nhau. Nay mỗi
    // lần cấp một id mới => hai download không bao giờ đụng nhau.
    const ids = [
      await allocateSpoofRuleId(),
      await allocateSpoofRuleId(),
      await allocateSpoofRuleId(),
    ];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toBeGreaterThanOrEqual(SPOOF_RULE_ID_MIN);
  });

  it('bộ đếm nằm trong storage.session (sống qua SW hồi sinh, không phải biến toàn cục)', async () => {
    const first = await allocateSpoofRuleId();
    // Đọc thẳng storage.session: bộ đếm PHẢI được ghi lại (SW MV3 ephemeral, biến toàn cục bốc hơi).
    const raw = await browser.storage.session.get('settings:dnrRuleCounter');
    expect(typeof raw['settings:dnrRuleCounter']).toBe('number');
    const second = await allocateSpoofRuleId();
    expect(second).toBe(first + 1);
  });

  it('id luôn nằm trong dải [MIN, MIN+SPAN) — không tràn sang dải rule khác', async () => {
    const id = await allocateSpoofRuleId();
    expect(id).toBeGreaterThanOrEqual(SPOOF_RULE_ID_MIN);
    expect(id).toBeLessThan(SPOOF_RULE_ID_MIN + SPOOF_RULE_ID_SPAN);
  });
});

describe('DownloadEntry — khoá ỔN ĐỊNH theo jobId (W2.5), chromeDownloadId có ở phase LƯU', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('put rồi get lại theo khoá string; KHÔNG cần chrome downloadId lúc bắt đầu (fetch trong offscreen)', async () => {
    await putDownload({
      key: 'job-1',
      mediaUrl: 'https://cdn.example.com/v.mp4',
      filename: 'v.mp4',
      state: 'in_progress',
      spoofRuleIds: [2000],
    });
    const all = await getDownloads();
    expect(Object.keys(all)).toEqual(['job-1']);
    expect(all['job-1']!.chromeDownloadId).toBeUndefined();
    expect(all['job-1']!.spoofRuleIds).toEqual([2000]);
  });

  it('updateDownload theo khoá MERGE, không mất field cũ (spoofRuleIds giữ nguyên khi gắn chromeDownloadId)', async () => {
    await putDownload({
      key: 'job-1',
      mediaUrl: 'https://cdn.example.com/v.mp4',
      state: 'in_progress',
      spoofRuleIds: [2000, 2001],
    });
    // Phase lưu: offscreen ghép xong -> background gắn id thật của chrome.downloads vào cùng entry.
    await updateDownload('job-1', { chromeDownloadId: 42, blobUrl: 'blob:x' });
    const e = (await getDownloads())['job-1']!;
    expect(e.chromeDownloadId).toBe(42);
    expect(e.blobUrl).toBe('blob:x');
    expect(e.spoofRuleIds).toEqual([2000, 2001]);
    expect(e.state).toBe('in_progress');
  });

  it('getDownloadByChromeId tra ngược từ id chrome (dùng cho downloads.onChanged)', async () => {
    await putDownload({
      key: 'job-1',
      mediaUrl: 'https://cdn.example.com/v.mp4',
      state: 'in_progress',
    });
    await putDownload({
      key: 'job-2',
      mediaUrl: 'https://cdn.example.com/w.mp4',
      state: 'in_progress',
      chromeDownloadId: 7,
    });
    const found = await getDownloadByChromeId(7);
    expect(found?.key).toBe('job-2');
    // Chưa gắn id thật -> không tra được (đúng: entry job-1 mới ở phase fetch).
    expect(await getDownloadByChromeId(999)).toBeUndefined();
  });

  it('updateDownload khoá chưa tồn tại -> upsert tối thiểu (không mất trạng thái do race onChanged)', async () => {
    await updateDownload('ghost', { state: 'complete' });
    const e = (await getDownloads())['ghost']!;
    expect(e.key).toBe('ghost');
    expect(e.state).toBe('complete');
  });
});

describe('W2.7 — phase kết thúc là CHUNG THẨM, không hồi sinh được', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  function job(patch: Partial<HlsJob> = {}): HlsJob {
    return {
      id: 'j1',
      mediaUrl: 'https://x/a.m3u8',
      variantUrl: 'https://x/v.m3u8',
      phase: 'fetching',
      segmentsTotal: 10,
      segmentsDone: 3,
      ...patch,
    };
  }

  it('job đã "cancelled" KHÔNG bị offscreen kéo ngược về "loading"', async () => {
    // Ca thật: user bấm Huỷ -> background ghi 'cancelled'; nhưng runHlsJob trong offscreen còn đang
    // chạy dở và kịp ghi 'loading' đè lên -> popup hiện job huỷ rồi lại quay tiếp. Vô lý với user.
    await putHlsJob(job({ phase: 'cancelled', error: 'Đã huỷ' }));
    await updateHlsJob('j1', { phase: 'loading' });
    expect((await getHlsJobs())['j1']!.phase).toBe('cancelled');
  });

  it('job đã "error" KHÔNG bị kéo ngược về "fetching"', async () => {
    // Ca thật W2.7: tick chốt job chết; nếu offscreen hồi sinh muộn và ghi tiếp thì spoof rule đã bị
    // dọn -> job chạy tiếp chỉ để 403, user nhận LỖI THỨ HAI khó hiểu hơn lỗi đầu.
    await putHlsJob(
      job({ phase: 'error', error: 'Bộ xử lý video đã dừng đột ngột' }),
    );
    await updateHlsJob('j1', { phase: 'fetching', segmentsDone: 9 });
    const j = (await getHlsJobs())['j1']!;
    expect(j.phase).toBe('error');
    expect(j.error).toBe('Bộ xử lý video đã dừng đột ngột');
  });

  it('vẫn cho ghi các field KHÁC lên job đã kết thúc (chỉ khoá phase + error)', async () => {
    await putHlsJob(job({ phase: 'done' }));
    await updateHlsJob('j1', { filename: 'x.mp4' });
    const j = (await getHlsJobs())['j1']!;
    expect(j.filename).toBe('x.mp4');
    expect(j.phase).toBe('done');
  });

  it('job đang chạy vẫn đổi phase bình thường (không khoá nhầm)', async () => {
    await putHlsJob(job({ phase: 'fetching' }));
    await updateHlsJob('j1', { phase: 'muxing' });
    expect((await getHlsJobs())['j1']!.phase).toBe('muxing');
  });

  it('job đang chạy vẫn vào được phase kết thúc', async () => {
    await putHlsJob(job({ phase: 'fetching' }));
    await updateHlsJob('j1', { phase: 'done' });
    expect((await getHlsJobs())['j1']!.phase).toBe('done');
  });
});

// ── W4.3 ────────────────────────────────────────────────────────────────────

describe('settings:filenameTemplate', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('mặc định là mẫu giữ nguyên hành vi cũ', async () => {
    expect(await getFilenameTemplate()).toBe('{title}{res}');
  });

  it('lưu rồi đọc lại', async () => {
    await setFilenameTemplate('{title}');
    expect(await getFilenameTemplate()).toBe('{title}');
  });

  it('mẫu rỗng -> lùi về mặc định', async () => {
    await setFilenameTemplate('   ');
    expect(await getFilenameTemplate()).toBe('{title}{res}');
  });

  // 🔴 Mẫu không có {title}/{basename} dồn MỌI video về một tên; conflictAction 'uniquify' lặng lẽ
  // thêm ' (1)', ' (2)'... nên user không bao giờ thấy lỗi — chỉ thấy một đống file vô danh.
  it('mẫu không phân biệt được video -> từ chối, lùi về mặc định', async () => {
    await setFilenameTemplate('{date}');
    expect(await getFilenameTemplate()).toBe('{title}{res}');
  });
});

describe('W4.3 navUrl theo tab', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('resetTab ghi navUrl của trang mới', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    expect((await getTabState(1)).navUrl).toBe('https://a.com/p');
  });

  it('setTabNavUrl chỉ đổi navUrl, KHÔNG đụng items/navStartedAt', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    await setTabNavUrl(1, 'https://a.com/q');
    const st = await getTabState(1);
    expect(st.navUrl).toBe('https://a.com/q');
    expect(st.navStartedAt).toBe(100);
    expect(st.items).toHaveLength(1);
  });

  // 🔴 GHIM CÁI BẪY XOÁ SẠCH: getTabState dựng lại object literal, field nào không được liệt kê
  // trong đó sẽ bị lần read-modify-write kế tiếp nuốt mất. Triệu chứng: tải ngay thì đúng, phát
  // hiện thêm một media nữa là mất tên. tsc/eslint/vitest hiện có ĐỀU KHÔNG THẤY.
  it('navUrl SỐNG SÓT qua lần ghi media kế tiếp', async () => {
    await setTabNavUrl(1, 'https://a.com/q');
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    expect((await getTabState(1)).navUrl).toBe('https://a.com/q');
  });

  it('điều hướng thật (resetTab không kèm URL) xoá navUrl', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    await resetTab(1, 200);
    expect((await getTabState(1)).navUrl).toBeUndefined();
  });

  // 🔴 Đây là mấu chốt để cổng sameDocument có dữ liệu THẬT trên đường phát hiện MẠNG: media bắt
  // qua webRequest không mang theo URL trang nào cả.
  it('media mới được đóng dấu URL trang LÚC PHÁT HIỆN', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    expect((await getTabMedia(1))[0]!.detectPageUrl).toBe('https://a.com/p');
  });

  // 🔴 CA NÀY TỪNG KHOÁ CHẶT MỘT HÀNH VI SAI — review đối kháng bắt được, nay đã lật lại.
  // Bản cũ ăn mừng việc `detectPageUrl` được điền ở nhánh MERGE. Nhưng điền muộn = đóng dấu media
  // của trang A bằng URL trang B: cùng một URL media hay được báo lại SAU khi user đã chuyển trang
  // SPA. Khi đó cổng sameDocument quay ra XÁC NHẬN cái sai -> tên video B nằm trên file video A.
  // Đúng, không đóng dấu thì mất tên đẹp — nhưng thà thiếu tên còn hơn SAI tên.
  it('KHÔNG điền detectPageUrl muộn ở nhánh MERGE (dấu là của LẦN ĐẦU)', async () => {
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    expect((await getTabMedia(1))[0]!.detectPageUrl).toBeUndefined();
    await setTabNavUrl(1, 'https://b.com/khac');
    await addTabMedia(1, item('https://a.com/v.m3u8'));
    expect((await getTabMedia(1))[0]!.detectPageUrl).toBeUndefined();
  });

  it('KHÔNG ghi đè detectPageUrl đã có sẵn', async () => {
    await resetTab(1, 100, 'https://a.com/p');
    await addTabMedia(
      1,
      item('https://a.com/v.m3u8', { detectPageUrl: 'https://b.com/' }),
    );
    expect((await getTabMedia(1))[0]!.detectPageUrl).toBe('https://b.com/');
  });
});
