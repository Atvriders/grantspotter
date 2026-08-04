/**
 * The reachable end of the print path (spec §11.3: "Opportunity brief | PDF | via a designed
 * `@media print` stylesheet + Print / Save as PDF"). There is no headless Chromium in this image
 * — see `styles/print.css`'s header comment for why — so this button IS the PDF feature: it opens
 * the browser's own print dialog against `print.css`, and "Save as PDF" is a destination the OS
 * print dialog already offers.
 *
 * `triggerPrint` is exported separately from the component so the click behaviour is testable
 * without a DOM: it takes anything with a `print()` method rather than reaching for the global
 * `window`, which is what lets `PrintButton.test.tsx` assert it with a bare `{ print: vi.fn() }`
 * and no jsdom.
 */
export function triggerPrint(target: { print: () => void }): void {
  target.print();
}

export interface PrintButtonProps {
  label?: string;
  className?: string;
}

/**
 * `no-print` is load-bearing, not decorative: `print.css` hides it with
 * `display: none !important` so the control itself never shows up on the printed page or the
 * saved PDF — a button cannot be clicked on paper.
 */
export function PrintButton({ label = 'Print / Save as PDF', className = '' }: PrintButtonProps): JSX.Element {
  return (
    <button
      type="button"
      className={`print-button no-print ${className}`.trim()}
      onClick={() => triggerPrint(window)}
    >
      {label}
    </button>
  );
}
