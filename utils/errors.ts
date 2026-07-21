// Normalize any error into a displayable string. Split out from entrypoints/offscreen/main.ts so it
// can be unit tested (main.ts is an entrypoint: it has top-level side effects + pulls in ffmpeg's Worker).
//
// NOTE on @ffmpeg/ffmpeg: the worker catches the error and sends `e.toString()` (dist/esm/worker.js:153),
// and classes.js:54 passes that string STRAIGHT into reject -> we receive the STRING "Error: <msg>",
// NOT an Error instance. Left as-is, the UI would concatenate it into "Lỗi: Error: ..." (ugly
// repetition). But there's ALSO a path that rejects with a real Error (ERROR_NOT_LOADED at
// classes.js:67, DOMException on abort at classes.js:75) -> both must be handled.

// The prefix produced by Error.prototype.toString(): "<name>: <message>". Strip ONLY names ending in
// "Error" (Error/TypeError/RangeError/...) or DOMException -> avoids wrongly cutting a legitimate
// message that contains ':' such as "HTTP 403: forbidden".
// The name-prefix part is OPTIONAL: a bare "Error:" must also match (this is exactly the ffmpeg-core case).
const ERROR_NAME_PREFIX_RE =
  /^(?:[A-Z][A-Za-z0-9_$]*)?(?:Error|DOMException):\s+/;

export function describeError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') {
    const stripped = e.replace(ERROR_NAME_PREFIX_RE, '');
    // A string that's nothing but the prefix -> keep it as-is rather than showing an empty "Lỗi: ".
    return stripped.trim() === '' ? e : stripped;
  }
  // A cross-realm error (from a different worker/iframe) won't pass `instanceof` -> take .message if present.
  if (
    typeof e === 'object' &&
    e !== null &&
    'message' in e &&
    typeof (e as { message: unknown }).message === 'string'
  ) {
    return (e as { message: string }).message;
  }
  return String(e);
}
