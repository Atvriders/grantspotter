import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SourceLink } from './SourceLink.js';

/**
 * CLOSE-OUT REVIEW RESIDUAL — `SourceLink` used ONE sentence for every refusal:
 * "…Its terms prohibit republishing what it holds…". True of the blocklisted aggregators. False
 * of a `javascript:` (or otherwise unparseable) address, which has no terms to prohibit anything —
 * `blockedHostFor` used to collapse `unsupported_scheme` and `unreadable` into the same string
 * shape as `blocked_host` (a scheme or a fixed label standing in for a "host"), so the licensing
 * sentence rendered underneath them too. A reader told the wrong reason cannot act on it, and a
 * technical refusal misattributed to a legal one is its own defect.
 *
 * `SourceLink` now reads `linkRefusal` directly and gives each of its three kinds its own honest
 * sentence. These tests assert the RENDERED TEXT of all three, that they are distinct from one
 * another, and that none of the two new ones borrows the licensing sentence.
 */
describe('SourceLink', () => {
  it('renders an ordinary https URL as a real anchor', () => {
    render(<SourceLink href="https://www.arrl.org/club-grant-program" />);
    expect(screen.getByRole('link')).toHaveAttribute(
      'href',
      'https://www.arrl.org/club-grant-program',
    );
  });

  it('blocked_host — farweb.org gets the safety-specific reason, not the licensing one', () => {
    render(<SourceLink href="https://www.farweb.org/scholarships" />);
    const warning = screen.getByRole('alert');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(warning).toHaveTextContent(/do not visit this address/i);
    expect(warning).toHaveTextContent(/gambling/i);
    expect(warning).not.toHaveTextContent(/terms prohibit republishing/i);
  });

  it('blocked_host — a commercial aggregator gets the licensing reason, which is true of it', () => {
    render(<SourceLink href="https://candid.org/some-listing" />);
    const warning = screen.getByRole('alert');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(warning).toHaveTextContent(/terms prohibit republishing/i);
  });

  it('unsupported_scheme — a javascript: address gets its own true reason, not the licensing one', () => {
    render(<SourceLink href="javascript:alert(document.cookie)" />);
    const warning = screen.getByRole('alert');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(warning).toHaveTextContent(/javascript:/i);
    expect(warning).toHaveTextContent(/scheme/i);
    expect(warning).not.toHaveTextContent(/terms prohibit republishing/i);
    expect(warning).not.toHaveTextContent(/hard-blocks/i);
  });

  it('unreadable — a protocol-relative address gets its own true reason, not the licensing one', () => {
    // `new URL('//www.farweb.org/scholarships')` throws, so this used to read as "not blocked"
    // and reach the page as a live anchor. It is refused here as `unreadable`, not `blocked_host`.
    render(<SourceLink href="//www.farweb.org/scholarships" />);
    const warning = screen.getByRole('alert');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(warning).toHaveTextContent(/not an absolute http or https url/i);
    expect(warning).not.toHaveTextContent(/terms prohibit republishing/i);
    expect(warning).not.toHaveTextContent(/hard-blocks/i);
  });

  it('gives all three refusal kinds distinct wording, each true of its own case', () => {
    render(
      <>
        <SourceLink href="https://www.farweb.org/scholarships" />
        <SourceLink href="javascript:alert(1)" />
        <SourceLink href="//www.farweb.org/scholarships" />
      </>,
    );
    const texts = screen.getAllByRole('alert').map((el) => el.textContent);
    expect(new Set(texts).size).toBe(texts.length);
  });

  it('still shows the address as text in every refusal case — withholding it would be its own silence', () => {
    render(<SourceLink href="javascript:alert(1)" />);
    expect(screen.getByText('javascript:alert(1)', { exact: false })).toBeInTheDocument();
  });

  /**
   * The class is the whole fix, so the class is what is asserted here.
   *
   * `source-url` is `overflow-wrap: anywhere` in `styles/base.css`. Without it this component
   * prints an address — one word, no spaces — as its own link text, and that word's rendered width
   * becomes a floor under every box up to the document: 112 of the 143 shipped records scrolled
   * the page sideways at 320, 360, 390, 414, 640, 700, 1024, 1280 and 1440, in both themes, until
   * 2026-08-10. Whether it still works is a browser's question and `e2e/responsive.spec.ts` asks
   * it; whether the class is still being applied is a question jsdom can answer in a millisecond,
   * at the moment somebody edits this file.
   */
  it('gives the anchor the class that lets a spaceless address break', () => {
    render(<SourceLink href="https://www.arrl.org/files/file/Foundation/Grant%20Application%20Form.pdf" />);
    expect(screen.getByRole('link').className.split(/\s+/)).toContain('source-url');
  });

  it('keeps a caller’s own class beside it rather than instead of it', () => {
    render(<SourceLink href="https://www.arrl.org/club-grant-program" className="wl-link" />);
    const classes = screen.getByRole('link').className.split(/\s+/);
    expect(classes).toContain('source-url');
    expect(classes).toContain('wl-link');
  });
});
