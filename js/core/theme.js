// Design tokens. One palette for the whole app: the board is graph paper, the ink is
// the player's moves, and each game only ever tints the accent.

export const T = {
  paper: '#f4efe3',
  paperDeep: '#ece5d5',
  card: '#fbf8f0',
  ink: '#2b2a26',
  inkSoft: '#6a655a',
  inkFaint: '#a9a294',
  rule: '#cfc7b3',
  ruleBold: '#9a937f',
  accent: '#1f6f5c',
  accentSoft: '#e2efe9',
  warn: '#b4522f',
  good: '#2f7d4f',
  gold: '#c08a2e',
  shadow: 'rgba(43, 42, 38, 0.18)',

  // Numberlink / any game that needs N distinguishable hues.
  hues: ['#d24c2c', '#2a6fb0', '#3f9a58', '#c8952a', '#8a4fa8', '#1d9a94',
    '#c0477f', '#5b6ee1', '#8a8a2a', '#b0603a', '#4a4a4a', '#2f8a8a'],

  radius: { sm: 6, md: 12, lg: 20 },
  space: [0, 4, 8, 12, 16, 22, 30, 42],
  font: '"Songti SC", "Noto Serif SC", Georgia, "Times New Roman", serif',
  // paper.js label() picks this for every clue, counter and digit on the board.
  mono: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
  mono: '"SF Mono", "JetBrains Mono", ui-monospace, Menlo, monospace',
};

// Numberlink pairs are distinguished by hue; adding a printed digit keeps them
// readable for colour-blind players and on a grey-scale screen.
export function hueOf(i) {
  return T.hues[i % T.hues.length];
}
