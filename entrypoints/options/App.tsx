import { useEffect, useState } from 'react';
import {
  DEFAULT_ENABLED_TYPES,
  getConcurrency,
  getDownloadFolder,
  getEnabledTypes,
  getFilenameTemplate,
  getSizeWarnBytes,
  setConcurrency,
  setDownloadFolder,
  setEnabledTypes,
  setFilenameTemplate,
  setSizeWarnBytes,
  type EnabledTypes,
} from '@/utils/storage';
import {
  buildDownloadFilename,
  DEFAULT_FILENAME_TEMPLATE,
  isUsableTemplate,
} from '@/utils/filename';
import { requestEngineSelfTest } from '@/utils/messages';
import type { MediaType } from '@/utils/types';

const GB = 1024 * 1024 * 1024;

const TYPE_LABEL: Record<MediaType, string> = {
  hls: 'HLS (.m3u8)',
  dash: 'DASH (.mpd)',
  progressive: 'Progressive (.mp4/.webm...)',
  blob: 'Blob/MSE (thử nghiệm)',
};

function App() {
  const [folder, setFolder] = useState('');
  const [sizeGb, setSizeGb] = useState('1.5');
  const [concurrency, setConcurrencyState] = useState(6);
  const [types, setTypes] = useState<EnabledTypes>(DEFAULT_ENABLED_TYPES);
  const [template, setTemplate] = useState(DEFAULT_FILENAME_TEMPLATE);
  const [saved, setSaved] = useState(false);

  const [ffBusy, setFfBusy] = useState(false);
  const [ffStatus, setFfStatus] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      setFolder(await getDownloadFolder());
      setSizeGb((((await getSizeWarnBytes()) / GB) * 1).toFixed(2));
      setConcurrencyState(await getConcurrency());
      setTypes(await getEnabledTypes());
      setTemplate(await getFilenameTemplate());
    })();
  }, []);

  const save = async () => {
    await setDownloadFolder(folder.trim());
    const gb = Number(sizeGb);
    if (Number.isFinite(gb) && gb > 0)
      await setSizeWarnBytes(Math.round(gb * GB));
    await setConcurrency(concurrency);
    await setFilenameTemplate(template.trim() || DEFAULT_FILENAME_TEMPLATE);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const toggleType = async (t: MediaType) => {
    const next = { ...types, [t]: !types[t] };
    setTypes(next);
    await setEnabledTypes(next);
  };

  const testEngine = async () => {
    setFfBusy(true);
    setFfStatus('Đang ghép thử một đoạn video mẫu…');
    const res = await requestEngineSelfTest();
    setFfBusy(false);
    setFfStatus(
      res.ok
        ? `✓ Bộ ghép video chạy tốt — ghép thử ra ${res.size.toLocaleString('vi-VN')} bytes.`
        : `✗ Lỗi: ${res.error}`,
    );
  };

  const labelStyle = {
    display: 'block',
    fontWeight: 600,
    marginBottom: 6,
  } as const;
  const inputStyle = {
    width: '100%',
    padding: '8px 10px',
    boxSizing: 'border-box',
  } as const;

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: 20,
        maxWidth: 620,
      }}
    >
      <h1>Your Video Is Mine — Cài đặt</h1>

      <section style={{ marginTop: 16 }}>
        <label htmlFor="folder" style={labelStyle}>
          Thư mục con trong Downloads
        </label>
        <input
          id="folder"
          type="text"
          value={folder}
          placeholder="vd: YourVideoIsMine (để trống = lưu thẳng vào Downloads)"
          onChange={(e) => setFolder(e.target.value)}
          style={inputStyle}
        />
        <p style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
          File lưu vào <code>Downloads/&lt;thư mục&gt;/</code>. Ký tự không hợp
          lệ thay bằng “_”.
        </p>
      </section>

      <section style={{ marginTop: 20 }}>
        <label htmlFor="tpl" style={labelStyle}>
          Mẫu tên file
        </label>
        <input
          id="tpl"
          type="text"
          value={template}
          placeholder={DEFAULT_FILENAME_TEMPLATE}
          onChange={(e) => setTemplate(e.target.value)}
          style={inputStyle}
        />
        <p style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
          Thẻ dùng được: <code>{'{title}'}</code> tên video ·{' '}
          <code>{'{res}'}</code> chất lượng (vd <code>_720p</code>) ·{' '}
          <code>{'{site}'}</code> tên trang · <code>{'{date}'}</code> ngày ·{' '}
          <code>{'{time}'}</code> giờ · <code>{'{basename}'}</code> tên từ URL.
          <br />
          Mẫu phải chứa <code>{'{title}'}</code> hoặc{' '}
          <code>{'{basename}'}</code>, nếu không mọi video sẽ trùng tên nhau và
          mẫu sẽ bị bỏ qua.
        </p>
        {/* Xem trước là bước xác nhận DUY NHẤT: tải về không hiện hộp thoại nào (saveAs: false),
            nên mẫu sai sẽ âm thầm nằm trên đĩa mà user không hề biết.
            🔴 W4.3 nợ — preview PHẢI đi qua đúng cổng `isUsableTemplate` như `getFilenameTemplate`
            lúc tải: mẫu bị từ chối (vd '{date}') thì tải THẬT lùi về mặc định, nên preview cũng phải
            hiện mẫu MẶC ĐỊNH. Bản cũ render mẫu thô -> preview NÓI DỐI cái mà đĩa không bao giờ thấy. */}
        <p style={{ fontSize: 13, marginTop: 6 }}>
          Xem trước:{' '}
          <code>
            {buildDownloadFilename({
              url: 'https://example.com/video/master.m3u8',
              title: 'Tên video mẫu',
              height: 720,
              pageUrl: 'https://example.com/watch',
              template: isUsableTemplate(template)
                ? template
                : DEFAULT_FILENAME_TEMPLATE,
              folder,
            })}
          </code>
          {!isUsableTemplate(template) && (
            <span style={{ color: '#c00', marginLeft: 8 }}>
              (mẫu thiếu {'{title}'}/{'{basename}'} — sẽ dùng mẫu mặc định)
            </span>
          )}
        </p>
      </section>

      <section style={{ marginTop: 20 }}>
        <label htmlFor="size" style={labelStyle}>
          Ngưỡng cảnh báo dung lượng (GB)
        </label>
        <input
          id="size"
          type="number"
          min="0.1"
          step="0.1"
          value={sizeGb}
          onChange={(e) => setSizeGb(e.target.value)}
          style={inputStyle}
        />
        <p style={{ fontSize: 13, opacity: 0.7, marginTop: 6 }}>
          Video HLS ước tính lớn hơn ngưỡng sẽ hỏi xác nhận trước khi tải (tránh
          cạn RAM).
        </p>
      </section>

      <section style={{ marginTop: 20 }}>
        <label htmlFor="conc" style={labelStyle}>
          Số luồng tải segment đồng thời (1–16)
        </label>
        <input
          id="conc"
          type="number"
          min="1"
          max="16"
          value={concurrency}
          onChange={(e) =>
            setConcurrencyState(
              Math.min(16, Math.max(1, Number(e.target.value) || 1)),
            )
          }
          style={inputStyle}
        />
      </section>

      <button
        type="button"
        onClick={() => void save()}
        style={{ marginTop: 14, padding: '8px 16px' }}
      >
        {saved ? 'Đã lưu ✓' : 'Lưu'}
      </button>

      <section
        style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #8884' }}
      >
        <h2 style={{ fontSize: 16, margin: '0 0 8px' }}>Hiển thị loại media</h2>
        {(Object.keys(TYPE_LABEL) as MediaType[]).map((t) => (
          <label key={t} style={{ display: 'block', margin: '4px 0' }}>
            <input
              type="checkbox"
              checked={types[t]}
              onChange={() => void toggleType(t)}
            />{' '}
            {TYPE_LABEL[t]}
          </label>
        ))}
      </section>

      <section
        style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid #8884' }}
      >
        <h2 style={{ fontSize: 16, margin: '0 0 6px' }}>Chẩn đoán</h2>
        <p style={{ fontSize: 13, opacity: 0.7, margin: '0 0 8px' }}>
          Ghép thử một đoạn video mẫu để kiểm bộ ghép (libav.wasm trong
          offscreen) có chạy được không.
        </p>
        <button
          type="button"
          disabled={ffBusy}
          onClick={() => void testEngine()}
          style={{ padding: '8px 16px' }}
        >
          {ffBusy ? 'Đang chạy…' : 'Kiểm tra bộ ghép video'}
        </button>
        {ffStatus && (
          <p style={{ fontSize: 13, marginTop: 10, whiteSpace: 'pre-wrap' }}>
            {ffStatus}
          </p>
        )}
      </section>
    </main>
  );
}

export default App;
