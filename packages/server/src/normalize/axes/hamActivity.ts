import type { ActivityKind, Constraint, RawOpportunity } from '@grantspotter/core';
import { makeConstraint } from './preference.js';

const CW_WPM = /\b(\d{1,3})\s*(?:wpm|words per minute)\b/i;

const KIND_PATTERNS: Array<[ActivityKind, RegExp]> = [
  ['club_member', /\bclub (?:member|membership|teaching|activit)\w*\b/i],
  ['ares_races_skywarn', /\b(ARES|RACES|SKYWARN)\b/],
  ['teaching', /\b(teach|instruct|licensing class|Elmer)\w*\b/i],
  ['on_air', /\bon[- ]air\b|\boperating activit\w*\b/i],
  ['field_day', /\bField Days?\b/i],
  ['contesting', /\bcontest(?:ing|s)?\b/i],
  ['public_service', /\bpublic services?\b/i],
];

export function extractHamActivity(raw: RawOpportunity): Constraint[] {
  const text = [raw.rawFields.Other, raw.rawFields.eligibility, raw.rawText].filter(Boolean).join('\n');
  const activityKinds = KIND_PATTERNS.filter(([, re]) => re.test(text)).map(([kind]) => kind);
  const cw = CW_WPM.exec(text);
  if (activityKinds.length === 0 && !cw) return [];
  const sentence =
    /[^.]*(?:ARES|RACES|SKYWARN|Field Day|contest|public service|club|teach|wpm)[^.]*\./i.exec(text)?.[0]?.trim() ??
    text;
  return [
    makeConstraint(
      'ham_activity',
      sentence,
      {
        axis: 'ham_activity',
        activityKinds,
        ...(cw ? { cwProficiencyWpmMin: Number.parseInt(cw[1], 10) } : {}),
        proofRequired: /\b(documented|documentation|proof|certificate|verified)\b/i.test(sentence),
      },
      0,
    ),
  ];
}
