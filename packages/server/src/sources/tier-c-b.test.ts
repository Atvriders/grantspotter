import { describe, expect, it } from 'vitest';
import { fixturePayload } from '../../test/fixtures.js';
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

describe('ncdxf-scholarships', () => {
  it('captures the age cap and the tuition-coverage benefit', () => {
    const raws = ncdxfScholarships.parse([
      fixturePayload('ncdxf-scholarships', 'pathological.html', 'https://www.ncdxf.org/pages/scholarships.html'),
    ]);
    expect(raws[0].rawFields.age).toMatch(/25 or younger/i);
    expect(raws[0].rawFields.benefit).toMatch(/tuition/i);
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
    expect(raws[0].rawFields.status).toMatch(/spring 2026/i);
  });

  it('records that NSPIRES has no machine route', () => {
    expect(nasaCsli.notes).toMatch(/NSPIRES/);
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
