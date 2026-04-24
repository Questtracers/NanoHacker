// Data used by the Corp Logo splash (src/corplogo.js).
// Drop new entries in any of these arrays — the splash picks one at random
// per run. No other code needs to change.

// A full corp name is built as `${NAME_PREFIXES[i]} ${NAME_SUFFIXES[j]}`.
export const NAME_PREFIXES = [
  'Satoshi', 'Neurosynth', 'Omnicorp', 'Zaibatsu', 'GAMP', 'Krypton',
  'Nexus', 'Pentagram', 'Oniric', 'Nakamura', 'Voidline', 'Helix',
  'Aegis', 'Daedalus', 'Yakuza', 'Obsidian', 'Hyperion', 'Kuro',
  'Hexane', 'Lumen', 'Nyx', 'Arasaka', 'Militech', 'Biotechnica',
  'Rayfield', 'Kang Tao',
];

export const NAME_SUFFIXES = [
  'Industries', 'Associated', 'Dynamics', 'Holdings', 'Systems',
  'Conglomerate', 'Networks', 'Group', 'Labs', 'Synthetics',
  'Global', 'International', 'Unlimited', 'Tech', 'Bioworks',
  'Securities',
];

// One per flavour — pharma / military / financial. One is chosen at random.
export const LEMAS = [
  'We take care of your health.',
  'National security protects freedom.',
  'Capital flows. We shape it.',
];
