import type { SourceModule } from '@grantspotter/core';
import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
import { extractLicense } from '../normalize/axes/index.js';
import {
  TIER_C_B_SOURCES,
  ariss,
  ieeeMtts,
  ieeeStudentBranchRebate,
  nasaCsli,
  ncdxfGrants,
  ncdxfScholarships,
  parseArissWindow,
} from './tier-c-b.js';

/**
 * The committed REAL captures under fixtures/<id>/00-*.html — pages actually pulled from
 * ncdxf.org, ariss-usa.org, mtt.org, students.ieee.org and nasa.gov on 2026-08-03 through the
 * production fetcher. Until they existed, every test in this file drove only the synthetic
 * pathological.html these same parsers were written against, which is how ncdxf-grants and
 * ieee-mtts both shipped parsers that return ZERO records from their own live page while the
 * suite stayed green, and how nasa-csli shipped a `benefit` field containing 1,100 characters
 * of unrelated NASA newsroom headlines. Each block below asserts EXACT field values read back
 * against the raw HTML, with the fixture line number, not merely that something parsed.
 */
const real = (id: string, file: string, url: string) => fixturePayload(id, file, url);

const REAL_FIXTURES: Array<[SourceModule, string, string]> = [
  [ncdxfGrants, '00-www-ncdxf-org-pages-grant-app-html.html', 'https://www.ncdxf.org/pages/grant-app.html'],
  [
    ncdxfScholarships,
    '00-www-ncdxf-org-pages-scholarships-html.html',
    'https://www.ncdxf.org/pages/scholarships.html',
  ],
  [ariss, '00-ariss-usa-org-proposal-overview.html', 'https://ariss-usa.org/proposal-overview/'],
  [ieeeMtts, '00-mtt-org-chapter-support.html', 'https://mtt.org/chapter-support/'],
  [
    ieeeStudentBranchRebate,
    '00-students-ieee-org-topics-submit-your-student-branch-annual-plan.html',
    'https://students.ieee.org/topics/submit-your-student-branch-annual-plan/',
  ],
  [
    nasaCsli,
    '00-www-nasa-gov-kennedy-launch-services-program-cubesat-launch-initiative.html',
    'https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/',
  ],
];

describe('ncdxf-grants', () => {
  const raws = ncdxfGrants.parse([
    fixturePayload('ncdxf-grants', 'pathological.html', 'https://www.ncdxf.org/pages/grant-app.html'),
  ]);

  it('captures the rolling lead time, the email intake and the financial-stake rule', () => {
    expect(raws[0].rawFields.leadTime).toMatch(/two months/i);
    expect(raws[0].rawFields.applyNote).toMatch(/treasurer/i);
    expect(raws[0].rawFields.stake).toMatch(/financial stake/i);
  });

  it('records in notes that this is not a collegiate program', () => {
    expect(ncdxfGrants.notes).toMatch(/not a collegiate program/i);
    expect(ncdxfGrants.notes).toMatch(/403/);
  });
});

describe('ncdxf-grants (REAL fixture)', () => {
  // Raw HTML, fixtures/ncdxf-grants/00-www-ncdxf-org-pages-grant-app-html.html:
  //   line 250: This page was updated January 3, 2014
  //   line 251: The Foundation makes cash grants to projects it believes will benefit
  //             <b><i>amateur radio</i></b> in general and DXing in particular.
  //   line 255: Applications must be made by completing (1) a Budget Worksheet and (2) an
  //             Application Form, and submitting both to NCDXF.
  // The word "treasurer" does not occur anywhere in this document — grep it. That is why the
  // old required `applyNote` pattern matched nothing and this source returned no records.
  const raws = ncdxfGrants.parse([
    real('ncdxf-grants', '00-www-ncdxf-org-pages-grant-app-html.html', 'https://www.ncdxf.org/pages/grant-app.html'),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].externalKey).toBe('ncdxf-grant-program');
  });

  it('captures the real intake sentence, not an emailed packet to a treasurer', () => {
    expect(raws[0].rawFields.applyNote).toBe(
      'Applications must be made by completing (1) a Budget Worksheet and (2) an Application Form, and submitting both to NCDXF.',
    );
    expect(raws[0].rawText).not.toMatch(/treasurer/i);
  });

  it('captures cash-grant purpose, lead time, cost share and the transport exclusion verbatim', () => {
    expect(raws[0].rawFields.summary).toBe(
      'The Foundation makes cash grants to projects it believes will benefit amateur radio in general and DXing in particular.',
    );
    expect(raws[0].rawFields.leadTime).toBe('two months lead time for action.');
    expect(raws[0].rawFields.stake).toContain('significant financial stake in their expedition');
    expect(raws[0].rawFields.restrictions).toContain(
      'we do not consider commercially available transportation costs',
    );
  });

  it('records how stale the live guidelines page admits to being', () => {
    expect(raws[0].rawFields.pageUpdated).toBe('This page was updated January 3, 2014');
  });

  it('reads the DXpedition grant page and never the scholarship page', () => {
    // NCDXF runs two distinct programs on one site. The grants page states the DXpedition
    // cost-share philosophy and says nothing about tuition; only the cross-links in the shared
    // navigation column mention scholarships at all.
    expect(raws[0].rawFields.summary).not.toMatch(/tuition|scholarship/i);
    expect(raws[0].sourceUrl).toBe('https://www.ncdxf.org/pages/grant-app.html');
  });
});

describe('ncdxf-scholarships', () => {
  it('captures the age cap and the tuition-coverage benefit', () => {
    const raws = ncdxfScholarships.parse([
      fixturePayload('ncdxf-scholarships', 'pathological.html', 'https://www.ncdxf.org/pages/scholarships.html'),
    ]);
    expect(raws[0].rawFields.age).toMatch(/25 or younger/i);
    expect(raws[0].rawFields.benefit).toMatch(/tuition/i);
    // The synthetic fixture's own wording of the same rule ("any license class"), which is the
    // second alternative in the `license` pattern and the shape 40+ ARRL catalog entries use.
    expect(raws[0].rawFields.license).toBe('Open to licensed amateurs 25 or younger, any license class.');
  });
});

describe('ncdxf-scholarships (REAL fixture)', () => {
  // Raw HTML, fixtures/ncdxf-scholarships/00-www-ncdxf-org-pages-scholarships-html.html:
  //   line 240: Starting April 22, 2013, NCDXF will provide full tuition scholarships for hams
  //             25 years of age and younger at all <a…>DX University</a> and
  //             <a…>Contest University </a>sessions held in North America for the next year.
  //   line 241: If you are a licensed amateur radio operator 25 years of age or younger, you can
  //             apply for a free tuition scholarship by contacting the appropriate University
  //             directly:
  //   line 250: Previous ARRL Foundation Scholarship Program (No Longer Active)
  // The live page never writes the "25 or younger" the old pattern required — always
  // "25 years of age and/or younger" — so the age cap silently vanished from the record.
  const raws = ncdxfScholarships.parse([
    real(
      'ncdxf-scholarships',
      '00-www-ncdxf-org-pages-scholarships-html.html',
      'https://www.ncdxf.org/pages/scholarships.html',
    ),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].externalKey).toBe('ncdxf-w6een-scholarship');
  });

  it('captures the age cap in the phrasing the page actually uses', () => {
    expect(raws[0].rawFields.age).toBe(
      'Starting April 22, 2013, NCDXF will provide full tuition scholarships for hams 25 years of age and younger at all DX University and Contest University sessions held in North America for the next year.',
    );
  });

  it('captures the tuition benefit and the apply-to-the-university-directly route', () => {
    expect(raws[0].rawFields.summary).toBe(
      'NCDXF will provide full tuition scholarships for hams 25 years of age and younger at all DX University and Contest University sessions held in North America for the next year.',
    );
    expect(raws[0].rawFields.applyNote).toBe(
      'If you are a licensed amateur radio operator 25 years of age or younger, you can apply for a free tuition scholarship by contacting the appropriate University directly:',
    );
  });

  it('never reads a dollar figure off this page — the $20,000 on it is a donation INTO the fund', () => {
    expect(raws[0].rawText).toContain('$20,000');
    expect(raws[0].rawFields.amount).toBeUndefined();
    expect(raws[0].rawFields.amountRaw).toBeUndefined();
  });

  it('attributes "No Longer Active" to the retired predecessor, not the current benefit', () => {
    // This heading sits above a 1998-2012 recipient table for the old ARRL-administered cash
    // scholarship. It is the reason normalize/deadline.ts's inactivity scan of rawText fires on
    // this record; capturing it explicitly is what lets a reviewer see the misattribution.
    expect(raws[0].rawFields.retiredPredecessor).toBe(
      'Previous ARRL Foundation Scholarship Program (No Longer Active)',
    );
    expect(raws[0].rawFields.benefit).toMatch(/full tuition scholarships/i);
  });

  it('reads the scholarship page and never the DXpedition grant page', () => {
    expect(raws[0].sourceUrl).toBe('https://www.ncdxf.org/pages/scholarships.html');
    expect(raws[0].rawFields.summary).not.toMatch(/DXpedition|budget worksheet/i);
  });

  // Raw HTML line 240, the closing sentence of the tuition paragraph:
  //   There is no restriction as to class of license.
  // It used to land nowhere `extractLicense` reads (the rest of that paragraph is captured as
  // `age`, and line 241's licence sentence as `applyNote`), so this record published with no
  // licence constraint at all — the same defect already fixed for QCWA and the three YLRL
  // scholarships in tier-c-a.ts.
  it('files the licence sentence under a field extractLicense actually reads', () => {
    expect(raws[0].rawFields.license).toBe('There is no restriction as to class of license.');
    // The other licence sentence on the page is deliberately NOT the anchor: it carries "25
    // years of age", which heldMonthsFrom would read as a 300-month licence-tenure requirement.
    expect(raws[0].rawFields.license).not.toMatch(/\d/);
  });

  it('computes the exact licence floor the live page states: TECH, with no tenure requirement', () => {
    const [constraint, ...rest] = extractLicense(raws[0]);
    expect(rest).toEqual([]);
    // "No restriction as to CLASS of license" presupposes a licence and disclaims only a floor
    // above the entry level, so the floor is TECH — never NONE. Reading it as NONE is what
    // publishes a licensed-operators-only award to an applicant with no amateur licence.
    expect(constraint.spec).toEqual({ axis: 'license', licenseMin: 'TECH' });
    expect(constraint.hard).toBe(true);
    expect(constraint.rawText).toBe('There is no restriction as to class of license.');
  });

  it('states the licence requirement in its notes, in the funder\'s own words', () => {
    expect(ncdxfScholarships.notes).toMatch(/AN AMATEUR RADIO LICENCE IS A HARD REQUIREMENT/);
    expect(ncdxfScholarships.notes).toMatch(/ANY CLASS QUALIFIES/);
  });
});

describe('parseArissWindow', () => {
  it('reads both ends of the quarterly-rewritten window sentence', () => {
    expect(parseArissWindow('The proposal window opened July 1, 2026 and closes September 30, 2026.')).toEqual({
      opensAt: '2026-07-01',
      closesAt: '2026-09-30',
    });
  });

  it('returns undefined rather than half a window', () => {
    expect(parseArissWindow('The proposal window will reopen soon.')).toBeUndefined();
  });
});

describe('ariss', () => {
  const raws = ariss.parse([
    fixturePayload('ariss', 'pathological.html', 'https://ariss-usa.org/proposal-overview/'),
  ]);

  it('captures the window sentence and the resolved dates', () => {
    expect(raws[0].rawFields.window).toMatch(/proposal window/i);
    expect(raws[0].rawFields.opensAt).toBe('2026-07-01');
    expect(raws[0].rawFields.closesAt).toBe('2026-09-30');
  });

  it('flags the unresolved college eligibility question rather than guessing', () => {
    expect(ariss.notes).toMatch(/not explicitly named/i);
  });
});

describe('ariss (REAL fixture)', () => {
  // Raw HTML, fixtures/ariss/00-ariss-usa-org-proposal-overview.html:
  //   line 178: A scheduled ARISS contact is a voice-only communication via Amateur Radio …
  //   line 190: US schools and educational organizations may download the <a…>ARISS Proposal
  //             Form</a> to submit a proposal to host an ARISS contact.
  //   line 243: … <b>Proposal window opened July 1 and closes on September 30 for contacts to be
  //             held from January to June 2027.</b>
  //   line 260: If you have questions regarding the proposal process, please send an email to:
  //             education@ariss-usa.org
  // Two live-only failures this proves fixed: the phrase "proposal window" occurs first at
  // line ~231 as "…submit it during the proposal window.", which the old pattern matched and
  // published as the field value "proposal window."; and the real dates carry NO YEAR.
  const raws = ariss.parse([
    real('ariss', '00-ariss-usa-org-proposal-overview.html', 'https://ariss-usa.org/proposal-overview/'),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].externalKey).toBe('ariss-iss-contact-proposal');
  });

  it('captures the dated window sentence rather than the first bare mention of the phrase', () => {
    expect(raws[0].rawFields.window).toBe(
      'Proposal window opened July 1 and closes on September 30 for contacts to be held from January to June 2027.',
    );
  });

  it('resolves both ends from a sentence that prints no year at all', () => {
    expect(raws[0].rawFields.window).not.toMatch(/July 1,? 20\d\d/);
    expect(raws[0].rawFields.opensAt).toBe('2026-07-01');
    expect(raws[0].rawFields.closesAt).toBe('2026-09-30');
  });

  it('captures the quarterly cadence and the schools-and-organizations eligibility', () => {
    expect(raws[0].rawFields.cadence).toBe(
      'Proposals from schools and organizations in the US are accepted during four proposal windows each year – one each quarter.',
    );
    expect(raws[0].rawFields.eligibility).toBe(
      'US schools and educational organizations may download the ARISS Proposal Form to submit a proposal to host an ARISS contact.',
    );
    expect(raws[0].rawFields.applyNote).toBe(
      'If you have questions regarding the proposal process, please send an email to: education@ariss-usa.org',
    );
  });

  it('is an organization-hosted contact with no cash and no individual applicant path', () => {
    // The domain fact ENTITIES_BY_SOURCE['ariss'] = ['school_lea', 'university'] encodes: the
    // live page offers contacts to institutions and organizations, and names no individual
    // applicant anywhere. It also promises no money — the benefit is a voice contact.
    expect(raws[0].rawFields.summary).toBe(
      'A scheduled ARISS contact is a voice-only communication via Amateur Radio between the International Space Station (ISS) crew and classrooms and communities.',
    );
    expect(raws[0].rawText).toMatch(/formal and informal education institutions and organizations/i);
    expect(raws[0].rawFields.amount).toBeUndefined();
    expect(raws[0].rawText).not.toMatch(/\$\d/);
  });
});

describe('ieee-mtts', () => {
  it('captures the Oct 1 deadline, the $1,000 amount and the chapter requirements', () => {
    const raws = ieeeMtts.parse([
      fixturePayload('ieee-mtts', 'pathological.html', 'https://mtt.org/chapter-support/'),
    ]);
    expect(raws[0].rawFields.deadline).toMatch(/October 1/);
    expect(raws[0].rawFields.amount).toContain('$1,000');
    expect(raws[0].rawFields.requirements).toMatch(/five members/i);
  });
});

describe('ieee-mtts (REAL fixture)', () => {
  // Raw HTML, fixtures/ieee-mtts/00-mtt-org-chapter-support.html:
  //   line 588: <li>Minimum of ten (10) members; five (5) members for Student Branch Chapters</li>
  //   line 610: … The amount of chapter activity financial support is $1,000 per year for
  //             single-society MTT-S Chapters or $500 per year for Joint Chapters …
  //   line 611: The fund provides $500 seed money per chapter …
  //   line 618: … through the <a href="https://form.jotform.com/243523980737161">Chapter
  //             Funding</a> form.
  //   line 619: <em>IMPORTANT: All requests for MTT chapter funding must be received by
  //             October 1 or the chapter may be asked to make its application in the following
  //             year.</em>
  // The live page never writes "due October 1" (the old required pattern) and never writes
  // "five members" (it writes "five (5) members"), so this source returned no records at all.
  const raws = ieeeMtts.parse([
    real('ieee-mtts', '00-mtt-org-chapter-support.html', 'https://mtt.org/chapter-support/'),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].externalKey).toBe('ieee-mtts-chapter-support');
  });

  it('captures the October 1 deadline in the wording the page actually uses', () => {
    expect(raws[0].rawFields.deadline).toBe(
      'IMPORTANT: All requests for MTT chapter funding must be received by October 1 or the chapter may be asked to make its application in the following year.',
    );
  });

  it('captures the $1,000 / $500 split, the $500 seed fund and the $2,250 travel ceiling', () => {
    expect(raws[0].rawFields.amount).toBe(
      'The amount of chapter activity financial support is $1,000 per year for single-society MTT-S Chapters or $500 per year for Joint Chapters which are associated with MTT-S.',
    );
    expect(raws[0].rawFields.workshopFund).toContain('$500 seed money per chapter');
    expect(raws[0].rawFields.travelSupport).toContain('up to $2,250 per year');
  });

  it('keeps the ten-members / five-members-for-student-branches distinction', () => {
    expect(raws[0].rawFields.requirements).toBe(
      'Minimum of ten (10) members; five (5) members for Student Branch Chapters',
    );
  });

  it('reads the year-keyed Jotform id live off the page instead of hardcoding it', () => {
    expect(raws[0].rawFields.formUrl).toBe('https://form.jotform.com/243523980737161');
  });

  it('claims no scholarship terms, because this page states none', () => {
    // MTT-S does run undergraduate scholarships and graduate fellowships, but on mtt.org/students/.
    // This page's only "Scholarship" strings are navigation links, so no amount or deadline for
    // them is invented here.
    expect(raws[0].rawFields.amount).not.toMatch(/scholarship/i);
    expect(raws[0].rawFields.deadline).not.toMatch(/scholarship/i);
  });
});

describe('ieee-student-branch-rebate', () => {
  it('captures the 15 March annual-plan deadline', () => {
    const raws = ieeeStudentBranchRebate.parse([
      fixturePayload(
        'ieee-student-branch-rebate',
        'pathological.html',
        'https://students.ieee.org/topics/submit-your-student-branch-annual-plan/',
      ),
    ]);
    expect(raws[0].rawFields.deadline).toMatch(/15 March/i);
  });

  it('records the HTTP 418 amount-page caveat', () => {
    expect(ieeeStudentBranchRebate.notes).toMatch(/418/);
  });
});

describe('ieee-student-branch-rebate (REAL fixture)', () => {
  // Raw HTML, fixtures/ieee-student-branch-rebate/00-students-ieee-org-topics-submit-your-
  // student-branch-annual-plan.html, line 555 — the entire body of this page is three sentences:
  //   <p>Student Branch Annual Plans are due 15 March. Submit your Branch&#8217;s Annual Plan
  //   through vTools Student Branch Reporting. Submitting an Annual Plan is required to qualify
  //   for a Student Branch Rebate.</p>
  // The old pattern started AT "15 March" and published the fragment "15 March." as the field.
  const raws = ieeeStudentBranchRebate.parse([
    real(
      'ieee-student-branch-rebate',
      '00-students-ieee-org-topics-submit-your-student-branch-annual-plan.html',
      'https://students.ieee.org/topics/submit-your-student-branch-annual-plan/',
    ),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].externalKey).toBe('ieee-student-branch-rebate');
  });

  it('captures the whole deadline sentence, not the bare date fragment', () => {
    expect(raws[0].rawFields.deadline).toBe('Student Branch Annual Plans are due 15 March.');
    expect(raws[0].rawFields.applyNote).toBe(
      'Submit your Branch’s Annual Plan through vTools Student Branch Reporting.',
    );
  });

  it('states in the page\'s own words that this qualifies for a REBATE, not a grant', () => {
    expect(raws[0].rawFields.summary).toBe(
      'Submitting an Annual Plan is required to qualify for a Student Branch Rebate.',
    );
    expect(ieeeStudentBranchRebate.notes).toMatch(/A REBATE, NOT A GRANT/);
  });

  it('publishes no rebate amount, because the live page contains no dollar figure at all', () => {
    expect(raws[0].rawText).not.toMatch(/\$/);
    expect(raws[0].rawFields.amount).toBeUndefined();
    expect(raws[0].rawFields.amountRaw).toBeUndefined();
  });
});

describe('nasa-csli', () => {
  it('captures the in-kind launch benefit and the ambiguous status sentence', () => {
    const raws = nasaCsli.parse([
      fixturePayload(
        'nasa-csli',
        'pathological.html',
        'https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/',
      ),
    ]);
    expect(raws[0].rawFields.benefit).toMatch(/launch/i);
    // `statusNote`, not `status`: normalize/deadline.ts reads rawFields.status as a
    // ProgramStatus override, and a prose sentence sitting under that key was ignored only
    // because it never happened to equal a known status string.
    expect(raws[0].rawFields.statusNote).toMatch(/spring 2026/i);
    expect(raws[0].rawFields.status).toBeUndefined();
  });

  it('records that NSPIRES has no machine route', () => {
    expect(nasaCsli.notes).toMatch(/NSPIRES/);
  });
});

describe('nasa-csli (REAL fixture)', () => {
  // Raw HTML, fixtures/nasa-csli/00-www-nasa-gov-kennedy-launch-services-program-cubesat-launch-
  // initiative.html, line 1432:
  //   NASA’s CubeSat Launch Initiative provides opportunities for CubeSats built by U.S.
  //   educational institutions, and non-profit organizations, including informal educational
  //   institutions such as museums and science centers to fly on upcoming launches. Through
  //   innovative technology partnerships NASA provides these CubeSat developers a low-cost
  //   pathway …
  // Everything above that line is a newsroom carousel with no sentence-ending period for over a
  // thousand characters, which the old leading `[^.]*` walked straight through.
  const raws = nasaCsli.parse([
    real(
      'nasa-csli',
      '00-www-nasa-gov-kennedy-launch-services-program-cubesat-launch-initiative.html',
      'https://www.nasa.gov/kennedy/launch-services-program/cubesat-launch-initiative/',
    ),
  ]);

  it('parses exactly one record from the live page', () => {
    expect(raws).toHaveLength(1);
    expect(raws[0].externalKey).toBe('nasa-csli');
  });

  it('captures the benefit sentence itself, not the newsroom carousel above it', () => {
    expect(raws[0].rawFields.benefit).toBe(
      'NASA’s CubeSat Launch Initiative provides opportunities for CubeSats built by U.S. educational institutions, and non-profit organizations, including informal educational institutions such as museums and science centers to fly on upcoming launches.',
    );
    // The abbreviation "U.S." must stay INSIDE the sentence — it was the false boundary the
    // fabricated 1,100-character capture terminated on.
    expect(raws[0].rawFields.benefit).toContain('U.S. educational institutions');
    expect(raws[0].rawFields.benefit).not.toMatch(/min read|article \d|Artemis/);
  });

  it('is a launch opportunity, never a dollar amount', () => {
    expect(raws[0].rawFields.summary).toContain('a low-cost pathway');
    expect(raws[0].rawFields.amount).toBeUndefined();
    expect(raws[0].rawFields.amountRaw).toBeUndefined();
    expect(Object.values(raws[0].rawFields).join(' ')).not.toMatch(/\$/);
  });

  it('carries the typical-cadence sentence the live page now states, and no confirmed window', () => {
    expect(raws[0].rawFields.applicationCycle).toBe(
      'CSLI’s Announcements of Partnership Opportunity is typically released each August with proposals due in November.',
    );
    // The "anticipates an update in spring 2026" sentence the notes used to quote is GONE from
    // the live page; nothing invents an open window in its place.
    expect(raws[0].rawText).not.toMatch(/anticipates/i);
    expect(raws[0].rawFields.statusNote).toBeUndefined();
  });
});

describe('every Tier C-B source against its REAL capture', () => {
  it('meets its own expectedMinRecords — the yield alarm the synthetic-only suite could not fire', () => {
    for (const [module, file, url] of REAL_FIXTURES) {
      const raws = module.parse([real(module.id, file, url)]);
      expect(raws.length, `${module.id} parsed ${raws.length} record(s) from its live page`).toBeGreaterThanOrEqual(
        module.expectedMinRecords,
      );
    }
  });

  it('never leaves a captured field empty or whitespace-only', () => {
    for (const [module, file, url] of REAL_FIXTURES) {
      for (const raw of module.parse([real(module.id, file, url)])) {
        for (const [key, value] of Object.entries(raw.rawFields)) {
          expect(value.trim(), `${module.id}.${key}`).not.toBe('');
        }
      }
    }
  });
});

describe('the group', () => {
  it('exports all six modules with unique ids', () => {
    expect(TIER_C_B_SOURCES.map((m) => m.id).sort()).toEqual([
      'ariss',
      'ieee-mtts',
      'ieee-student-branch-rebate',
      'nasa-csli',
      'ncdxf-grants',
      'ncdxf-scholarships',
    ]);
  });
});
