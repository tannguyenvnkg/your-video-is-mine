import { beforeEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  addTabMedia,
  clearTabMedia,
  getPreferredHeight,
  getTabMedia,
  resetTab,
  setPreferredHeight,
} from './storage';
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
