/**
 * WCAG 2.x relative luminance and contrast ratio, over `#rrggbb` strings.
 *
 * This exists so the design system's accessibility claim is executable. `contrast.test.ts` reads
 * `styles/tokens.css` off disk and asserts every semantic foreground/background pair clears
 * 4.5:1 in BOTH themes — so a token edit that dims a verdict badge past AA turns the suite red
 * instead of shipping.
 */

export function parseHex(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) throw new Error(`expected #rrggbb, got: ${hex}`);
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

function channelLuminance(value255: number): number {
  const c = value255 / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return (
    0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b)
  );
}

export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}
