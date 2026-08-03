import type { RawOpportunity, SourceModule } from '@grantspotter/core';
import { type SinglePageConfig, makeSinglePageSource } from './util/singlePage.js';

const YLRL_HEADING =
  /^((?:Ethel Smith|Mary Lou Brown|Marte Wessel)[^\n]*Scholarship)$/gim;

/** One YLRL page carries three distinct named scholarships; each becomes its own record. */
export function parseYlrlScholarships(flatText: string, sourceUrl: string): RawOpportunity[] {
  const out: RawOpportunity[] = [];
  const lines = flatText.split('\n');
  lines.forEach((line, i) => {
    YLRL_HEADING.lastIndex = 0;
    if (!YLRL_HEADING.test(line.trim())) return;
    const body = lines.slice(i + 1, i + 4).join('\n');
    const amount = /\$[\d,]+/.exec(body)?.[0];
    const rawFields: Record<string, string> = { scope: 'named_scholarship' };
    if (amount) rawFields.amount = amount;
    out.push({
      sourceId: 'ylrl',
      externalKey: line.trim(),
      name: line.trim(),
      rawFields,
      sourceUrl,
      rawText: [line.trim(), body].join('\n').trim(),
    });
  });
  return out;
}

const CONFIGS: SinglePageConfig[] = [
  {
    id: 'qcwa',
    funderId: 'qcwa',
    label: 'QCWA Memorial Scholarship Fund',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://www.qcwa.org/scholarship-program.htm',
    name: 'QCWA Memorial Scholarship',
    externalKey: 'qcwa-memorial-scholarship',
    fieldPatterns: {
      amount: /(\$3,000)/,
      sponsor: /(sponsored by an active QCWA member[^.]*\.)/i,
      deadlineNote: /(before the first week of January[^.]*\.)/i,
      applyNote: /(ARRL[^.]*(?:portal|application|Foundation)[^.]*\.)/i,
    },
    requiredFields: ['amount'],
    expectedMinRecords: 1,
    notes:
      '$3,000 each; 2024: 15 awards / $57,000; 624+ students / $930,350+ since 1978. Intake is ' +
      'the ARRL Foundation portal, NOT QCWA — the deadline is INHERITED from ' +
      'arrl-scholarship-program. A sponsoring active QCWA member is a hard requirement. The ' +
      'page still references the FAR website for a historical fund; farweb.org is refused ' +
      'inside the fetcher because that domain now redirects to a gambling site.',
  },
  {
    id: 'ylrl',
    funderId: 'ylrl',
    label: 'Young Ladies Radio League scholarships',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://ylrl.net/Scholarships/',
    name: 'YLRL Scholarships',
    externalKey: 'ylrl-scholarships',
    fieldPatterns: { eligibility: /(licensed[^.]*(?:women|female|YL)[^.]*\.)/i },
    requiredFields: ['eligibility'],
    expectedMinRecords: 3,
    extraParse: (flat, _html, sourceUrl) => parseYlrlScholarships(flat, sourceUrl),
    notes:
      'Female licensed hams only — the ONLY gender-scoped record in the corpus, and the reason ' +
      'ConstraintAxis has a gender axis. Three named scholarships on one page: Ethel Smith ' +
      'K4LMB ($2,500), Mary Lou Brown NM7N ($2,500), Marte Wessel K0EPE ($1,500, aimed at ' +
      'part-time students working full-time). Non-US applicants eligible; YLRL membership is a ' +
      'preference, not a bar. One of only two verified non-ARRL US ham scholarship application ' +
      'paths.',
  },
  {
    id: 'austin-arc',
    funderId: 'austin-arc',
    label: 'Austin Amateur Radio Club scholarships',
    tier: 'C',
    klass: 'ham_scholarship',
    url: 'https://austinhams.org/scholarships/',
    name: 'Austin ARC Copeland and Greenwood Scholarships',
    externalKey: 'austin-arc-scholarships',
    fieldPatterns: {
      window: /(May\s*1[^.]*?Jul(?:y)?\s*31)/i,
      counties: /((?:Travis|Williamson|Hays|Bastrop|Caldwell|Burnet|Blanco)[^.]*\.)/i,
    },
    requiredFields: ['window'],
    expectedMinRecords: 0,
    notes:
      'expectedMinRecords is deliberately 0. grants.austinhams.org legitimately shows "No ' +
      'opportunities available" between August 1 and April 30 — an empty scrape here is the ' +
      'correct answer for eight months of the year, not a failure, and diff/ must not emit ' +
      'vanished events for it. Window is May 1 - Jul 31; search engines still show a stale ' +
      '"March 25, 2026" that contradicts the live page. Central Texas, seven named counties. ' +
      'Amounts unpublished since the site rebuild. The self-hosted portal exposes no public ' +
      'JSON — /api* probes return 404. Best verified example of a regional non-ARRL program.',
  },
  {
    id: 'sara',
    funderId: 'sara',
    label: 'SARA Student and Teacher Project Grants',
    tier: 'C',
    klass: 'equipment_in_kind',
    url: 'https://www.radio-astronomy.org/grants',
    name: 'SARA Student and Teacher Project Grants',
    externalKey: 'sara-student-teacher-grants',
    fieldPatterns: {
      amount: /(\$200[^.]*\.)/i,
      audience: /((?:5th|fifth) grade[^.]*college[^.]*\.)/i,
      applyNote: /([\w.+-]+@radio-astronomy\.org)/i,
    },
    requiredFields: ['audience'],
    expectedMinRecords: 1,
    notes:
      'Society of Amateur Radio Astronomers. Students 5th grade through college plus teachers, ' +
      'international. Typically <= $200 ("or more with committee approval"), one $500 outlier; ' +
      'often kits (Radio JOVE, SuperSID) rather than cash, so the instrument is ' +
      'in_kind_equipment. ROLLING — no deadline appears anywhere on the page, so DeadlineKind ' +
      'is rolling, never a guessed date. Apply by emailing a Word/PDF form to the address on ' +
      'the page.',
  },
];

const [qcwaModule, ylrlModule, austinModule, saraModule] = CONFIGS.map(makeSinglePageSource);

export const qcwa = qcwaModule;
export const ylrl = ylrlModule;
export const austinArc = austinModule;
export const sara = saraModule;
export const TIER_C_A_SOURCES: SourceModule[] = [qcwa, ylrl, austinArc, sara];
