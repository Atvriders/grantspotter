export interface ArrlSection {
  name: string;
  abbrev: string;
  division: string;
  states: string[];
}

/** The 15 US ARRL Divisions. Canada left the ARRL Field Organization in 2009. */
export const ARRL_DIVISIONS: readonly string[] = [
  'Atlantic',
  'Central',
  'Dakota',
  'Delta',
  'Great Lakes',
  'Hudson',
  'Midwest',
  'New England',
  'Northwestern',
  'Pacific',
  'Roanoke',
  'Rocky Mountain',
  'Southeastern',
  'Southwestern',
  'West Gulf',
];

/** The 71 US ARRL Sections, with their official abbreviations. */
export const ARRL_SECTIONS: readonly ArrlSection[] = [
  { name: 'Delaware', abbrev: 'DE', division: 'Atlantic', states: ['DE'] },
  { name: 'Eastern Pennsylvania', abbrev: 'EPA', division: 'Atlantic', states: ['PA'] },
  { name: 'Maryland-DC', abbrev: 'MDC', division: 'Atlantic', states: ['MD', 'DC'] },
  { name: 'Northern New York', abbrev: 'NNY', division: 'Atlantic', states: ['NY'] },
  { name: 'Southern New Jersey', abbrev: 'SNJ', division: 'Atlantic', states: ['NJ'] },
  { name: 'Western New York', abbrev: 'WNY', division: 'Atlantic', states: ['NY'] },
  { name: 'Western Pennsylvania', abbrev: 'WPA', division: 'Atlantic', states: ['PA'] },

  { name: 'Illinois', abbrev: 'IL', division: 'Central', states: ['IL'] },
  { name: 'Indiana', abbrev: 'IN', division: 'Central', states: ['IN'] },
  { name: 'Wisconsin', abbrev: 'WI', division: 'Central', states: ['WI'] },

  { name: 'Minnesota', abbrev: 'MN', division: 'Dakota', states: ['MN'] },
  { name: 'North Dakota', abbrev: 'ND', division: 'Dakota', states: ['ND'] },
  { name: 'South Dakota', abbrev: 'SD', division: 'Dakota', states: ['SD'] },

  { name: 'Arkansas', abbrev: 'AR', division: 'Delta', states: ['AR'] },
  { name: 'Louisiana', abbrev: 'LA', division: 'Delta', states: ['LA'] },
  { name: 'Mississippi', abbrev: 'MS', division: 'Delta', states: ['MS'] },
  { name: 'Tennessee', abbrev: 'TN', division: 'Delta', states: ['TN'] },

  { name: 'Kentucky', abbrev: 'KY', division: 'Great Lakes', states: ['KY'] },
  { name: 'Michigan', abbrev: 'MI', division: 'Great Lakes', states: ['MI'] },
  { name: 'Ohio', abbrev: 'OH', division: 'Great Lakes', states: ['OH'] },

  { name: 'Eastern New York', abbrev: 'ENY', division: 'Hudson', states: ['NY'] },
  { name: 'NYC-Long Island', abbrev: 'NLI', division: 'Hudson', states: ['NY'] },
  { name: 'Northern New Jersey', abbrev: 'NNJ', division: 'Hudson', states: ['NJ'] },

  { name: 'Iowa', abbrev: 'IA', division: 'Midwest', states: ['IA'] },
  { name: 'Kansas', abbrev: 'KS', division: 'Midwest', states: ['KS'] },
  { name: 'Missouri', abbrev: 'MO', division: 'Midwest', states: ['MO'] },
  { name: 'Nebraska', abbrev: 'NE', division: 'Midwest', states: ['NE'] },

  { name: 'Connecticut', abbrev: 'CT', division: 'New England', states: ['CT'] },
  { name: 'Eastern Massachusetts', abbrev: 'EMA', division: 'New England', states: ['MA'] },
  { name: 'Maine', abbrev: 'ME', division: 'New England', states: ['ME'] },
  { name: 'New Hampshire', abbrev: 'NH', division: 'New England', states: ['NH'] },
  { name: 'Rhode Island', abbrev: 'RI', division: 'New England', states: ['RI'] },
  { name: 'Vermont', abbrev: 'VT', division: 'New England', states: ['VT'] },
  { name: 'Western Massachusetts', abbrev: 'WMA', division: 'New England', states: ['MA'] },

  { name: 'Alaska', abbrev: 'AK', division: 'Northwestern', states: ['AK'] },
  { name: 'Eastern Washington', abbrev: 'EWA', division: 'Northwestern', states: ['WA'] },
  { name: 'Idaho', abbrev: 'ID', division: 'Northwestern', states: ['ID'] },
  { name: 'Montana', abbrev: 'MT', division: 'Northwestern', states: ['MT'] },
  { name: 'Oregon', abbrev: 'OR', division: 'Northwestern', states: ['OR'] },
  { name: 'Western Washington', abbrev: 'WWA', division: 'Northwestern', states: ['WA'] },

  { name: 'East Bay', abbrev: 'EB', division: 'Pacific', states: ['CA'] },
  { name: 'Nevada', abbrev: 'NV', division: 'Pacific', states: ['NV'] },
  { name: 'Pacific', abbrev: 'PAC', division: 'Pacific', states: ['HI', 'AS', 'GU', 'MP'] },
  { name: 'Sacramento Valley', abbrev: 'SV', division: 'Pacific', states: ['CA'] },
  { name: 'San Francisco', abbrev: 'SF', division: 'Pacific', states: ['CA'] },
  { name: 'San Joaquin Valley', abbrev: 'SJV', division: 'Pacific', states: ['CA'] },
  { name: 'Santa Clara Valley', abbrev: 'SCV', division: 'Pacific', states: ['CA'] },

  { name: 'North Carolina', abbrev: 'NC', division: 'Roanoke', states: ['NC'] },
  { name: 'South Carolina', abbrev: 'SC', division: 'Roanoke', states: ['SC'] },
  { name: 'Virginia', abbrev: 'VA', division: 'Roanoke', states: ['VA'] },
  { name: 'West Virginia', abbrev: 'WV', division: 'Roanoke', states: ['WV'] },

  { name: 'Colorado', abbrev: 'CO', division: 'Rocky Mountain', states: ['CO'] },
  { name: 'New Mexico', abbrev: 'NM', division: 'Rocky Mountain', states: ['NM'] },
  { name: 'Utah', abbrev: 'UT', division: 'Rocky Mountain', states: ['UT'] },
  { name: 'Wyoming', abbrev: 'WY', division: 'Rocky Mountain', states: ['WY'] },

  { name: 'Alabama', abbrev: 'AL', division: 'Southeastern', states: ['AL'] },
  { name: 'Georgia', abbrev: 'GA', division: 'Southeastern', states: ['GA'] },
  { name: 'Northern Florida', abbrev: 'NFL', division: 'Southeastern', states: ['FL'] },
  { name: 'Puerto Rico', abbrev: 'PR', division: 'Southeastern', states: ['PR'] },
  { name: 'Southern Florida', abbrev: 'SFL', division: 'Southeastern', states: ['FL'] },
  { name: 'US Virgin Islands', abbrev: 'VI', division: 'Southeastern', states: ['VI'] },
  { name: 'West Central Florida', abbrev: 'WCF', division: 'Southeastern', states: ['FL'] },

  { name: 'Arizona', abbrev: 'AZ', division: 'Southwestern', states: ['AZ'] },
  { name: 'Los Angeles', abbrev: 'LAX', division: 'Southwestern', states: ['CA'] },
  { name: 'Orange', abbrev: 'ORG', division: 'Southwestern', states: ['CA'] },
  { name: 'San Diego', abbrev: 'SDG', division: 'Southwestern', states: ['CA'] },
  { name: 'Santa Barbara', abbrev: 'SB', division: 'Southwestern', states: ['CA'] },

  { name: 'North Texas', abbrev: 'NTX', division: 'West Gulf', states: ['TX'] },
  { name: 'Oklahoma', abbrev: 'OK', division: 'West Gulf', states: ['OK'] },
  { name: 'South Texas', abbrev: 'STX', division: 'West Gulf', states: ['TX'] },
  { name: 'West Texas', abbrev: 'WTX', division: 'West Gulf', states: ['TX'] },
];
