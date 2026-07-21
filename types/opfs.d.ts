// Minimal declaration for the OPFS SyncAccessHandle — TypeScript's DOM lib doesn't have it yet
// (it only exists inside a Worker). ACTUALLY MEASURED in this extension's real Worker:
//   typeof FileSystemSyncAccessHandle === 'function'
//   sah_methods = ["write","read","truncate","flush","close","getSize"]
// On the offscreen main thread, `createSyncAccessHandle` is undefined — that's why the stitching
// step must run inside a Worker.
interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, options?: { at?: number }): number;
  write(
    buffer: ArrayBufferView | ArrayBuffer,
    options?: { at?: number },
  ): number;
  truncate(newSize: number): void;
  flush(): void;
  close(): void;
  getSize(): number;
}

interface FileSystemFileHandle {
  createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
}
