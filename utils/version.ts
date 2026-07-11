// Helper thuần: tạo nhãn phiên bản hiển thị trên popup. Tách riêng để unit test.
export function formatVersionLabel(name: string, version: string): string {
  return `${name} v${version}`;
}
