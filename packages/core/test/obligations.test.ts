import { describe, expect, it } from 'vitest';
import { obligationsSchema, obligationState } from '../src/index.js';
import type { ObligationState, Obligations } from '../src/index.js';

/**
 * CONTRACT §3 + §10 amendment 7 — the tri-state.
 *
 * `costShareRequired` and `coFunderPreference` were non-optional booleans, and
 * `normalize/index.ts` opened every record with `costShareRequired: false, coFunderPreference:
 * false`. 144 of the 150 publishable records therefore published the positive claim "this funder
 * does not require cost sharing" without a single funder having said it. These tests pin the
 * three states apart at the type, schema and reader level, so the collapse cannot come back
 * quietly.
 */
describe('obligations are tri-state: required, not required, and unstated', () => {
  it('reads a funder’s stated yes and stated no as different answers', () => {
    expect(obligationState(true)).toBe('yes');
    expect(obligationState(false)).toBe('no');
  });

  it('reads silence as UNSTATED, never as a no', () => {
    // The whole point. `obligationState(undefined)` must not equal `obligationState(false)`,
    // because a blank prompts an applicant to go and check and a false negative does not — and a
    // cost-share requirement discovered after the award is what makes it unusable to a club with
    // no matching funds.
    expect(obligationState(undefined)).toBe('unstated');
    expect(obligationState(undefined)).not.toBe(obligationState(false));
  });

  it('accepts an obligations object that answers neither question', () => {
    // Absent keys, not `false` keys. Before the amendment zod REQUIRED both booleans, which is
    // what left normalize/ no way to say "no page addressed this" and forced the invented `false`.
    const unstated = obligationsSchema.parse({});
    expect(unstated.costShareRequired).toBeUndefined();
    expect(unstated.coFunderPreference).toBeUndefined();
    expect(obligationState(unstated.costShareRequired)).toBe('unstated');
  });

  it('still round-trips both stated values through the schema', () => {
    const stated = obligationsSchema.parse({ costShareRequired: true, coFunderPreference: false });
    expect(obligationState(stated.costShareRequired)).toBe('yes');
    expect(obligationState(stated.coFunderPreference)).toBe('no');
  });

  it('does not let an absent obligation serialise as a stated one', () => {
    // JSON is how these reach the browser (Plan 3) and the JSON columns in SQLite. An unstated
    // obligation must not arrive at either as `false`.
    const o: Obligations = {};
    const wire = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
    expect('costShareRequired' in wire).toBe(false);
    expect('coFunderPreference' in wire).toBe(false);
  });

  it('gives a consumer an exhaustively-checked switch, so a forgotten arm cannot compile', () => {
    // A renderer that writes `o.costShareRequired ? 'Required' : 'Not required'` compiles, ships,
    // and is wrong for every unstated record. Going through the union forces the third branch.
    const label = (value: boolean | undefined): string => {
      const state: ObligationState = obligationState(value);
      switch (state) {
        case 'yes':
          return 'Cost share required';
        case 'no':
          return 'No cost share required';
        case 'unstated':
          return 'Not stated — check with the funder';
        default: {
          const never: never = state;
          return never;
        }
      }
    };
    expect(label(true)).toBe('Cost share required');
    expect(label(false)).toBe('No cost share required');
    expect(label(undefined)).toBe('Not stated — check with the funder');
  });
});
