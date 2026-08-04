import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { programStatusSchema } from '@grantspotter/core';
import { TrustBadge } from './TrustBadge.js';
import { StatusPill } from './StatusPill.js';

const NOW = '2026-08-02T12:00:00.000Z';

describe('TrustBadge', () => {
  it('shows a verified date inside 90 days', () => {
    render(<TrustBadge lastVerifiedAt="2026-07-30T00:00:00.000Z" now={NOW} />);
    const badge = screen.getByLabelText(/verified 3 days ago/i);
    expect(badge).toHaveTextContent('2026-07-30');
    expect(badge).not.toHaveClass('trust-unverified');
  });

  it('goes amber past 90 days and says the word unverified', () => {
    render(<TrustBadge lastVerifiedAt="2026-01-05T00:00:00.000Z" now={NOW} />);
    const badge = screen.getByLabelText(/unverified/i);
    expect(badge).toHaveClass('trust-unverified');
    expect(badge).toHaveTextContent('Unverified');
  });

  it('never renders a bare date with no provenance word', () => {
    render(<TrustBadge lastVerifiedAt="2026-07-30T00:00:00.000Z" now={NOW} />);
    expect(screen.getByText(/verified/i)).toBeInTheDocument();
  });

  it('says how old the record is, not just when it was checked', () => {
    render(<TrustBadge lastVerifiedAt="2026-01-05T00:00:00.000Z" now={NOW} />);
    expect(screen.getByLabelText(/209 days ago/i)).toBeInTheDocument();
  });

  it('renders exactly 90 days as still verified, and 91 as not', () => {
    const { unmount } = render(<TrustBadge lastVerifiedAt="2026-05-04T12:00:00.000Z" now={NOW} />);
    expect(screen.getByLabelText(/^Verified/)).toBeInTheDocument();
    unmount();
    render(<TrustBadge lastVerifiedAt="2026-05-03T12:00:00.000Z" now={NOW} />);
    expect(screen.getByLabelText(/^Unverified/)).toBeInTheDocument();
  });

  it('says "today" rather than "0 days ago"', () => {
    render(<TrustBadge lastVerifiedAt="2026-08-02T06:00:00.000Z" now={NOW} />);
    expect(screen.getByLabelText(/verified today/i)).toBeInTheDocument();
  });

  it('says "1 day ago", not "1 days ago"', () => {
    render(<TrustBadge lastVerifiedAt="2026-08-01T06:00:00.000Z" now={NOW} />);
    expect(screen.getByLabelText(/verified 1 day ago/i)).toBeInTheDocument();
  });

  it('treats an unreadable verification date as unverified with an em dash, never as fresh', () => {
    render(<TrustBadge lastVerifiedAt="" now={NOW} />);
    const badge = screen.getByLabelText(/unverified/i);
    expect(badge).toHaveTextContent('Unverified');
    expect(badge).toHaveTextContent('—');
    expect(badge.getAttribute('aria-label')).toMatch(/date unknown/i);
  });

  it('carries the 90-day rule in its tooltip, so the amber is explained where it appears', () => {
    render(<TrustBadge lastVerifiedAt="2026-01-05T00:00:00.000Z" now={NOW} />);
    expect(screen.getByLabelText(/unverified/i).getAttribute('title')).toMatch(/90 days/);
  });
});

describe('StatusPill', () => {
  it('renders unknown as a labelled state, never a blank', () => {
    render(<StatusPill status="unknown" />);
    expect(screen.getByLabelText('Status: unknown')).toHaveTextContent('Unknown');
  });

  it('renders discontinued distinctly from closed', () => {
    const { rerender } = render(<StatusPill status="discontinued" />);
    expect(screen.getByLabelText('Status: discontinued')).toHaveTextContent('Discontinued');
    rerender(<StatusPill status="closed" />);
    expect(screen.getByLabelText('Status: closed')).toHaveTextContent('Closed');
  });

  it('renders no_application in words a human uses', () => {
    render(<StatusPill status="no_application" />);
    expect(screen.getByLabelText('Status: no_application'))
      .toHaveTextContent('No application exists');
  });

  /**
   * Derived from core's own enum rather than a hand-written list: 118 of the 150 published
   * records carry `unknown`, and a status the design forgot would render as an empty cell for
   * whichever slice of the corpus holds it. A new `ProgramStatus` fails here until it has words.
   */
  it.each(programStatusSchema.options)('renders %s with real words and a stable label', (status) => {
    render(<StatusPill status={status} />);
    const pill = screen.getByLabelText(`Status: ${status}`);
    expect(pill.textContent?.trim().length ?? 0).toBeGreaterThan(0);
    // The machine name never leaks into the visible text.
    expect(pill.textContent).not.toContain('_');
  });

  it('explains what the status means, since "dormant" is not self-evident', () => {
    render(<StatusPill status="dormant" />);
    expect(screen.getByLabelText('Status: dormant').getAttribute('title')?.length ?? 0)
      .toBeGreaterThan(10);
  });
});
