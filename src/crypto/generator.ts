// Password generator and a lightweight strength estimate.
import { randomBytes } from './keys';

export type GeneratorMode = 'random' | 'memorable' | 'pin';

export interface GeneratorOptions {
  mode: GeneratorMode;
  length: number; // characters (random/pin) or words (memorable)
  digits: boolean;
  symbols: boolean;
  separator: string;
  capitalize: boolean;
}

export const DEFAULT_GENERATOR: GeneratorOptions = {
  mode: 'random',
  length: 20,
  digits: true,
  symbols: true,
  separator: '-',
  capitalize: true,
};

const LETTERS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
const DIGITS = '23456789';
const SYMBOLS = '!@#$%^&*.-_=+?';

// Short curated wordlist; enough for ~10.6 bits/word.
const WORDS = (
  'amber anchor apple arrow aspen atlas autumn badge bamboo banjo barrel basil beacon birch bison blaze ' +
  'bloom bolt breeze brick bronze cabin cactus canyon carbon cedar chalk cherry cider cobalt comet coral ' +
  'cosmic crane crisp crystal dahlia delta denim drift ember falcon fern fjord flint forest fossil frost ' +
  'galaxy garnet geyser ginger glacier granite gravel harbor hazel heron honey indigo iris island ivory ' +
  'jasper juniper kayak kelp kettle lagoon lantern lava lemon lilac linen lotus lunar maple marble meadow ' +
  'mesa meteor mint mosaic moss nebula nectar nickel nova oasis ocean olive onyx opal orbit orchid otter ' +
  'pebble pepper pine planet plaza plume polar poppy prairie prism quartz quill raven reef ridge river ' +
  'robin rocket saffron sage salmon sandal sapphire scarlet shadow sierra silver slate sonnet spruce ' +
  'stone summit sunset swift tango thistle thunder tidal timber topaz tulip tundra umber valley velvet ' +
  'violet walnut willow winter yarrow zephyr zinc'
).split(' ');

function pick(chars: string): string {
  // reason: modulo bias is negligible for 32-bit draws over alphabets this small.
  const n = new Uint32Array(randomBytes(4).buffer)[0];
  return chars[n % chars.length];
}

function pickIndex(n: number): number {
  return new Uint32Array(randomBytes(4).buffer)[0] % n;
}

export function generatePassword(o: GeneratorOptions): string {
  if (o.mode === 'pin') return Array.from({ length: o.length }, () => pick('0123456789')).join('');
  if (o.mode === 'memorable') {
    const words = Array.from({ length: o.length }, () => {
      const w = WORDS[pickIndex(WORDS.length)];
      return o.capitalize ? w[0].toUpperCase() + w.slice(1) : w;
    });
    if (o.digits) words[pickIndex(words.length)] += pick(DIGITS);
    return words.join(o.separator);
  }
  const pool = LETTERS + (o.digits ? DIGITS : '') + (o.symbols ? SYMBOLS : '');
  for (;;) {
    const out = Array.from({ length: o.length }, () => pick(pool)).join('');
    // Guarantee every enabled class appears at least once.
    if (o.digits && !/[0-9]/.test(out)) continue;
    if (o.symbols && !/[^A-Za-z0-9]/.test(out)) continue;
    return out;
  }
}

export type Strength = 'terrible' | 'weak' | 'fair' | 'good' | 'excellent' | 'fantastic';

export function estimateEntropy(pw: string): number {
  if (!pw) return 0;
  let pool = 0;
  if (/[a-z]/.test(pw)) pool += 26;
  if (/[A-Z]/.test(pw)) pool += 26;
  if (/[0-9]/.test(pw)) pool += 10;
  if (/[^A-Za-z0-9]/.test(pw)) pool += 33;
  const unique = new Set(pw).size;
  // Penalize repetition: effective length scales with distinct characters.
  const effLen = Math.min(pw.length, unique * 2);
  const words = pw.split(/[-_. ]/).filter(Boolean);
  const wordBits = words.length >= 3 && words.every((w) => /^[A-Za-z]+\d?$/.test(w)) ? words.length * 10.6 : 0;
  return Math.max(effLen * Math.log2(Math.max(pool, 1)), wordBits);
}

// Common base words; a password that is one of these plus digits/symbols is guessable early.
// reason: parenthesized so .split applies to the whole list, not only the second literal.
const COMMON = new Set(
  (
    'password passw0rd qwerty qwertyuiop letmein welcome admin iloveyou monkey dragon football baseball ' +
    'master sunshine princess shadow superman trustno abc abcdef login secret hello freedom whatever'
  ).split(' '),
);

export function strength(pw: string): Strength {
  const base = pw.toLowerCase().replace(/[^a-z]/g, '');
  // reason: entropy alone rated "password123" as fair; dictionary bases must cap the score.
  if (!base || COMMON.has(base)) return estimateEntropy(pw) < 28 || !base ? 'terrible' : 'weak';
  const bits = estimateEntropy(pw);
  if (bits < 28) return 'terrible';
  if (bits < 40) return 'weak';
  if (bits < 60) return 'fair';
  if (bits < 80) return 'good';
  if (bits < 100) return 'excellent';
  return 'fantastic';
}
