import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PrintButton, triggerPrint } from './PrintButton.js';

describe('triggerPrint', () => {
  it('calls print on the window it is given', () => {
    const target = { print: vi.fn() };
    triggerPrint(target);
    expect(target.print).toHaveBeenCalledTimes(1);
  });
});

describe('PrintButton', () => {
  it('renders the default label', () => {
    expect(renderToStaticMarkup(<PrintButton />)).toContain('Print / Save as PDF');
  });

  it('is marked no-print so it never appears on the printed page', () => {
    expect(renderToStaticMarkup(<PrintButton />)).toContain('no-print');
  });

  it('accepts a custom label and extra classes', () => {
    const html = renderToStaticMarkup(<PrintButton label="Print brief" className="wide" />);
    expect(html).toContain('Print brief');
    expect(html).toContain('wide');
    expect(html).toContain('no-print');
  });

  it('renders a real button element with an explicit type', () => {
    expect(renderToStaticMarkup(<PrintButton />)).toContain('type="button"');
  });
});
