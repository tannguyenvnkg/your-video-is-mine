// Khai báo tối thiểu cho OPFS SyncAccessHandle — lib DOM của TypeScript chưa có (nó chỉ tồn
// tại trong Worker). ĐO ĐƯỢC trong Worker thật của extension này:
//   typeof FileSystemSyncAccessHandle === 'function'
//   sah_methods = ["write","read","truncate","flush","close","getSize"]
// Ở luồng chính offscreen thì `createSyncAccessHandle` là undefined — đó là lý do việc ghép
// bắt buộc phải nằm trong Worker.
interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(buffer: ArrayBufferView | ArrayBuffer, options?: { at?: number }): number;
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
  getSize(): number;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
