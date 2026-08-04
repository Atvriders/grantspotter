import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * jsdom implements neither. `api/exports.ts`'s blob-download path
 * (`URL.createObjectURL(blob)` → a synthetic `<a download>` click →
 * `URL.revokeObjectURL(url)`) is exactly what a real browser does for the three POST exports
 * (DOCX / Markdown / packet ZIP), and there is no alternative code path the way `Blob.text()` had
 * one in `FileReader` — a download has to produce SOME object URL to point the anchor at. The
 * stub below is a fixed string, never a real object URL, so nothing here should assert on its
 * shape; the point is only that `saveBlob` does not throw `TypeError: URL.createObjectURL is not
 * a function` in the test environment.
 */
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:jsdom-stub';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => undefined;
}

afterEach(() => {
  cleanup();
});
