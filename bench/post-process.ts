import {
  createRainbowPostProcess,
  type RainbowBuffer,
  type RainbowColor,
  type RainbowConfig,
  type RainbowTheme,
} from "../rainbow-post-process.ts";

const eps = 1 / 510;
const speed = 0.008;
const turns = 3;
const glow = 0.05;
const top = "▀".charCodeAt(0);
const tilt = (25 * Math.PI) / 180;
const dx = Math.cos(tilt);
const dy = Math.sin(tilt);
const deltaCycle = [16.2, 16.5, 16.7, 16.9, 17.1, 16.8, 16.6, 16.4];
const warmupFrames = 64;
const measureFrames = 1280;
const samples = 10;
const verifyFrames = 240;

type ImplFactory = (
  theme: () => RainbowTheme,
  value: () => RainbowConfig,
) => (buffer: RainbowBuffer, delta: number) => void;

type ThemeMode =
  | {
      kind: "static";
      themes: readonly [RainbowTheme];
    }
  | {
      kind: "flip";
      themes: readonly [RainbowTheme, RainbowTheme];
    };

type Scenario = {
  name: string;
  width: number;
  height: number;
  cfg: RainbowConfig;
  themeMode: ThemeMode;
  templateFg: Float32Array;
  templateBg: Float32Array;
  templateChar: Uint32Array;
};

type Summary = {
  median: number;
  mean: number;
  cv: number;
};

const rgba = (r: number, g: number, b: number, a = 255): RainbowColor => ({
  r: r / 255,
  g: g / 255,
  b: b / 255,
  a: a / 255,
});

const alt = (ink: RainbowColor, delta: number): RainbowColor => ({
  r: Math.max(0, Math.min(1, ink.r + delta)),
  g: Math.max(0, Math.min(1, ink.g - delta * 0.4)),
  b: Math.max(0, Math.min(1, ink.b + delta * 0.25)),
  a: ink.a,
});

const mix = (a: RainbowColor, b: RainbowColor, t: number): RainbowColor => ({
  r: a.r + (b.r - a.r) * t,
  g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t,
  a: a.a + (b.a - a.a) * t,
});

const toIntsKey = (ink: RainbowColor) => {
  return [
    Math.round(ink.r * 255),
    Math.round(ink.g * 255),
    Math.round(ink.b * 255),
    Math.round(ink.a * 255),
  ].join(",");
};

const rgbKey = (ink: RainbowColor) => {
  return [Math.round(ink.r * 255), Math.round(ink.g * 255), Math.round(ink.b * 255)].join(",");
};

const pickColor = (list: RainbowColor[], rand: () => number) =>
  list[Math.floor(rand() * list.length)] ?? list[0]!;

const setColor = (buf: Float32Array | Uint16Array, slot: number, ink: RainbowColor) => {
  writeColorValue(buf, slot, ink.r);
  writeColorValue(buf, slot + 1, ink.g);
  writeColorValue(buf, slot + 2, ink.b);
  writeColorValue(buf, slot + 3, ink.a);
};

const same = (ink: RainbowColor, r: number, g: number, b: number) => {
  return Math.abs(ink.r - r) <= eps && Math.abs(ink.g - g) <= eps && Math.abs(ink.b - b) <= eps;
};

const uniq = (list: RainbowColor[]) => {
  const seen = new Set<string>();
  return list.filter((ink) => {
    const key = toIntsKey(ink);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const hit = (list: RainbowColor[], r: number, g: number, b: number) => {
  return list.some((ink) => same(ink, r, g, b));
};

const UINT16_SCALE = 255;

const isUint16Buffer = (buf: Float32Array | Uint16Array): buf is Uint16Array => {
  return buf instanceof Uint16Array;
};

const readColorValue = (buf: Float32Array | Uint16Array, slot: number): number => {
  if (isUint16Buffer(buf)) {
    return (buf[slot] ?? 0) / UINT16_SCALE;
  }
  return buf[slot] ?? 0;
};

const writeColorValue = (buf: Float32Array | Uint16Array, slot: number, value: number): void => {
  if (isUint16Buffer(buf)) {
    buf[slot] = Math.round(value * UINT16_SCALE);
  } else {
    buf[slot] = value;
  }
};

const paint = (
  buf: Float32Array | Uint16Array,
  slot: number,
  list: RainbowColor[],
  step: number,
  amt: number,
) => {
  const pos = (((step % 1) + 1) % 1) * list.length || 0;
  const idx = Math.floor(pos);
  const gap = pos - idx;
  const a = list[idx]!;
  const z = list[(idx + 1) % list.length]!;
  const r = a.r + (z.r - a.r) * gap;
  const g = a.g + (z.g - a.g) * gap;
  const b = a.b + (z.b - a.b) * gap;
  const prevR = readColorValue(buf, slot);
  const prevG = readColorValue(buf, slot + 1);
  const prevB = readColorValue(buf, slot + 2);

  writeColorValue(buf, slot, prevR + (r - prevR) * amt);
  writeColorValue(buf, slot + 1, prevG + (g - prevG) * amt);
  writeColorValue(buf, slot + 2, prevB + (b - prevB) * amt);
};

const pick = (theme: RainbowTheme) => {
  const list = uniq([
    mix(theme.text, theme.primary, 0.4),
    theme.primary,
    mix(theme.primary, theme.accent, 0.5),
    theme.accent,
    mix(theme.accent, theme.secondary, 0.5),
    theme.secondary,
    mix(theme.secondary, theme.textMuted, 0.35),
  ]);

  if (list.length) return list;
  return [theme.primary];
};

const createBaselinePostProcess: ImplFactory = (theme, value) => {
  let time = 0;

  return (buffer, delta) => {
    const cfg = value();
    if (!cfg.fg && (!cfg.bg || !cfg.glow)) return;
    time += delta * cfg.speed;

    const skin = theme();
    const list = pick(skin);
    const bgmark = uniq([
      skin.background,
      skin.backgroundPanel,
      skin.backgroundElement,
      skin.backgroundMenu,
    ]);
    const fgmark = [skin.text, skin.textMuted];
    const span = Math.max(1, buffer.width * dx + buffer.height * dy);
    const fg = buffer.buffers.fg;
    const bg = buffer.buffers.bg;
    const char = buffer.buffers.char;
    const blur = Math.max(0.5, cfg.turns * 0.55);

    for (let y = 0; y < buffer.height; y++) {
      for (let x = 0; x < buffer.width; x++) {
        const cell = y * buffer.width + x;
        const slot = cell * 4;
        const r = readColorValue(fg, slot);
        const g = readColorValue(fg, slot + 1);
        const b = readColorValue(fg, slot + 2);
        const step = ((x * dx + y * dy) / span) * cfg.turns + time * 0.1;
        if (cfg.fg && hit(fgmark, r, g, b)) {
          paint(fg, slot, list, step, 1);
        }

        if (!cfg.bg || !cfg.glow) continue;

        const br = readColorValue(bg, slot);
        const bgg = readColorValue(bg, slot + 1);
        const bb = readColorValue(bg, slot + 2);
        if (!hit(bgmark, br, bgg, bb)) continue;

        const haze = ((x * dx + y * dy) / span) * blur + time * 0.04 + 0.17;
        const rise = Math.sin((((haze % 1) + 1) % 1) * Math.PI);
        const amt = cfg.glow * (0.35 + 0.65 * rise * rise);
        paint(bg, slot, list, haze, amt);

        if (char[cell] === top && hit(bgmark, r, g, b)) {
          paint(fg, slot, list, haze, amt);
        }
      }
    }
  };
};

const createRng = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
};

const themeA: RainbowTheme = {
  text: rgba(235, 238, 245),
  textMuted: rgba(142, 149, 169),
  primary: rgba(91, 140, 255),
  accent: rgba(255, 121, 198),
  secondary: rgba(80, 227, 194),
  background: rgba(18, 21, 28),
  backgroundPanel: rgba(24, 28, 38),
  backgroundElement: rgba(30, 34, 46),
  backgroundMenu: rgba(22, 25, 34),
};

const themeB: RainbowTheme = {
  text: rgba(248, 238, 255),
  textMuted: rgba(182, 168, 200),
  primary: rgba(255, 157, 80),
  accent: rgba(255, 210, 84),
  secondary: rgba(255, 210, 84),
  background: rgba(14, 11, 24),
  backgroundPanel: rgba(20, 17, 30),
  backgroundElement: rgba(20, 17, 30),
  backgroundMenu: rgba(28, 24, 42),
};

const themeC: RainbowTheme = {
  text: rgba(226, 245, 240),
  textMuted: rgba(130, 161, 154),
  primary: rgba(72, 196, 255),
  accent: rgba(89, 255, 166),
  secondary: rgba(182, 117, 255),
  background: rgba(10, 19, 20),
  backgroundPanel: rgba(12, 26, 28),
  backgroundElement: rgba(17, 35, 37),
  backgroundMenu: rgba(12, 26, 28),
};

const collectUnique = (
  themes: readonly RainbowTheme[],
  pickList: (theme: RainbowTheme) => RainbowColor[],
) => {
  const seen = new Set<string>();
  const result: RainbowColor[] = [];
  for (const theme of themes) {
    for (const ink of pickList(theme)) {
      const key = rgbKey(ink);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(ink);
    }
  }
  return result;
};

const createScenario = (input: {
  name: string;
  width: number;
  height: number;
  cfg: RainbowConfig;
  themeMode: ThemeMode;
  seed: number;
  fgNeutralRate: number;
  bgNeutralRate: number;
  topRate: number;
}) => {
  const themes = input.themeMode.themes;
  const neutralFg = collectUnique(themes, (theme) => [theme.text, theme.textMuted]);
  const neutralBg = collectUnique(themes, (theme) => [
    theme.background,
    theme.backgroundPanel,
    theme.backgroundElement,
    theme.backgroundMenu,
  ]);
  const vividFg = collectUnique(themes, (theme) => [
    theme.primary,
    theme.accent,
    theme.secondary,
    mix(theme.primary, theme.accent, 0.35),
    mix(theme.secondary, theme.textMuted, 0.2),
    alt(theme.primary, 0.08),
  ]);
  const vividBg = collectUnique(themes, (theme) => [
    alt(theme.background, 0.09),
    alt(theme.backgroundPanel, 0.12),
    alt(theme.backgroundElement, 0.07),
    mix(theme.primary, theme.background, 0.18),
    mix(theme.accent, theme.backgroundMenu, 0.12),
  ]);
  const rand = createRng(input.seed);
  const size = input.width * input.height;
  const templateFg = new Float32Array(size * 4);
  const templateBg = new Float32Array(size * 4);
  const templateChar = new Uint32Array(size);

  for (let cell = 0, slot = 0; cell < size; cell++, slot += 4) {
    let fgColor =
      rand() < input.fgNeutralRate ? pickColor(neutralFg, rand) : pickColor(vividFg, rand);
    const bgColor =
      rand() < input.bgNeutralRate ? pickColor(neutralBg, rand) : pickColor(vividBg, rand);
    let code = 33 + (cell % 90);

    if (rand() < input.topRate) {
      code = top;
      if (rand() < 0.72) {
        fgColor = pickColor(neutralBg, rand);
      }
    }

    setColor(templateFg, slot, fgColor);
    setColor(templateBg, slot, bgColor);
    templateChar[cell] = code;
  }

  return {
    name: input.name,
    width: input.width,
    height: input.height,
    cfg: input.cfg,
    themeMode: input.themeMode,
    templateFg,
    templateBg,
    templateChar,
  } satisfies Scenario;
};

const scenarios = [
  createScenario({
    name: "80x24 balanced both",
    width: 80,
    height: 24,
    cfg: { fg: true, bg: true, speed, turns, glow },
    themeMode: { kind: "static", themes: [themeA] },
    seed: 0x1a2b3c4d,
    fgNeutralRate: 0.4,
    bgNeutralRate: 0.48,
    topRate: 0.08,
  }),
  createScenario({
    name: "160x48 dense both",
    width: 160,
    height: 48,
    cfg: { fg: true, bg: true, speed: 0.012, turns: 4.5, glow: 0.08 },
    themeMode: { kind: "static", themes: [themeB] },
    seed: 0x0badf00d,
    fgNeutralRate: 0.58,
    bgNeutralRate: 0.65,
    topRate: 0.14,
  }),
  createScenario({
    name: "160x48 fg only",
    width: 160,
    height: 48,
    cfg: { fg: true, bg: false, speed: 0.01, turns: 5.25, glow },
    themeMode: { kind: "static", themes: [themeC] },
    seed: 0x1234abcd,
    fgNeutralRate: 0.64,
    bgNeutralRate: 0.2,
    topRate: 0.03,
  }),
  createScenario({
    name: "160x48 bg only",
    width: 160,
    height: 48,
    cfg: { fg: false, bg: true, speed: 0.01, turns: 4.25, glow: 0.08 },
    themeMode: { kind: "static", themes: [themeA] },
    seed: 0x34ab98ef,
    fgNeutralRate: 0.22,
    bgNeutralRate: 0.72,
    topRate: 0.16,
  }),
  createScenario({
    name: "80x24 theme flip",
    width: 80,
    height: 24,
    cfg: { fg: true, bg: true, speed: 0.014, turns: 2.75, glow: 0.07 },
    themeMode: { kind: "flip", themes: [themeA, themeC] },
    seed: 0x55aa10ef,
    fgNeutralRate: 0.46,
    bgNeutralRate: 0.52,
    topRate: 0.11,
  }),
];

const createBuffer = (scenario: Scenario): RainbowBuffer => ({
  width: scenario.width,
  height: scenario.height,
  buffers: {
    char: new Uint32Array(scenario.templateChar.length),
    fg: new Float32Array(scenario.templateFg.length),
    bg: new Float32Array(scenario.templateBg.length),
  },
});

const resetBuffer = (scenario: Scenario, buffer: RainbowBuffer) => {
  (buffer.buffers.char as Uint32Array).set(scenario.templateChar);
  buffer.buffers.fg.set(scenario.templateFg);
  buffer.buffers.bg.set(scenario.templateBg);
};

const createThemeDriver = (scenario: Scenario) => {
  let theme = scenario.themeMode.themes[0];
  return {
    get: () => theme,
    setFrame(frame: number) {
      if (scenario.themeMode.kind === "flip") {
        theme = scenario.themeMode.themes[frame % scenario.themeMode.themes.length]!;
        return;
      }
      theme = scenario.themeMode.themes[0];
    },
  };
};

const bun = (globalThis as { Bun?: { version: string; gc: (force?: boolean) => void } }).Bun;

const forceGc = () => {
  if (bun && typeof bun.gc === "function") {
    bun.gc(true);
    return;
  }

  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
};

const now = () => process.hrtime.bigint();

let sink = 0;

const touchBuffer = (buffer: RainbowBuffer) => {
  sink +=
    buffer.buffers.fg[0]! + buffer.buffers.fg[7]! + buffer.buffers.bg[5]! + buffer.buffers.char[3]!;
};

const quantile = (sorted: number[], t: number) => {
  const idx = (sorted.length - 1) * t;
  const low = Math.floor(idx);
  const high = Math.ceil(idx);
  if (low === high) return sorted[low]!;
  const gap = idx - low;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * gap;
};

const summarize = (values: number[]): Summary => {
  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    median: quantile(sorted, 0.5),
    mean,
    cv: mean === 0 ? 0 : Math.sqrt(variance) / mean,
  };
};

const measureOne = (
  factory: ImplFactory,
  scenario: Scenario,
  buffer: RainbowBuffer,
  sample: number,
) => {
  const value = () => scenario.cfg;
  const theme = createThemeDriver(scenario);
  const processFrame = factory(theme.get, value);

  resetBuffer(scenario, buffer);
  for (let frame = 0; frame < warmupFrames; frame++) {
    theme.setFrame(frame);
    processFrame(buffer, deltaCycle[frame % deltaCycle.length]!);
  }

  forceGc();
  resetBuffer(scenario, buffer);

  const start = now();
  for (let frame = 0; frame < measureFrames; frame++) {
    theme.setFrame(frame + warmupFrames);
    processFrame(buffer, deltaCycle[(frame + sample) % deltaCycle.length]!);
  }
  const end = now();

  touchBuffer(buffer);
  forceGc();
  return Number(end - start) / measureFrames / 1_000;
};

const measurePair = (scenario: Scenario) => {
  const baselineTimes: number[] = [];
  const currentTimes: number[] = [];
  const left = createBuffer(scenario);
  const right = createBuffer(scenario);

  for (let sample = 0; sample < samples; sample++) {
    const even = sample % 2 === 0;
    const firstFactory = even ? createBaselinePostProcess : createRainbowPostProcess;
    const secondFactory = even ? createRainbowPostProcess : createBaselinePostProcess;
    const firstTime = measureOne(firstFactory, scenario, left, sample);
    const secondTime = measureOne(secondFactory, scenario, right, sample);

    if (even) {
      baselineTimes.push(firstTime);
      currentTimes.push(secondTime);
      continue;
    }

    currentTimes.push(firstTime);
    baselineTimes.push(secondTime);
  }

  return {
    baseline: summarize(baselineTimes),
    current: summarize(currentTimes),
  };
};

const verifyScenario = (scenario: Scenario) => {
  const value = () => scenario.cfg;
  const themeA = createThemeDriver(scenario);
  const themeB = createThemeDriver(scenario);
  const baseline = createBaselinePostProcess(themeA.get, value);
  const current = createRainbowPostProcess(themeB.get, value);
  const left = createBuffer(scenario);
  const right = createBuffer(scenario);
  resetBuffer(scenario, left);
  resetBuffer(scenario, right);

  for (let frame = 0; frame < verifyFrames; frame++) {
    const delta = deltaCycle[frame % deltaCycle.length]!;
    themeA.setFrame(frame);
    themeB.setFrame(frame);
    baseline(left, delta);
    current(right, delta);
  }

  let maxFgDiff = 0;
  let maxBgDiff = 0;
  for (let i = 0; i < left.buffers.fg.length; i++) {
    maxFgDiff = Math.max(maxFgDiff, Math.abs(left.buffers.fg[i]! - right.buffers.fg[i]!));
  }
  for (let i = 0; i < left.buffers.bg.length; i++) {
    maxBgDiff = Math.max(maxBgDiff, Math.abs(left.buffers.bg[i]! - right.buffers.bg[i]!));
  }
  for (let i = 0; i < left.buffers.char.length; i++) {
    if (left.buffers.char[i] !== right.buffers.char[i]) {
      throw new Error(`${scenario.name}: char mismatch at cell ${i}`);
    }
  }

  if (maxFgDiff > 1e-6 || maxBgDiff > 1e-6) {
    throw new Error(
      `${scenario.name}: buffer mismatch fg=${maxFgDiff.toExponential(3)} bg=${maxBgDiff.toExponential(3)}`,
    );
  }

  return { maxFgDiff, maxBgDiff };
};

const formatUs = (value: number) => `${value.toFixed(2).padStart(8)} us`;
const formatPct = (value: number) => `${(value * 100).toFixed(2).padStart(6)}%`;
const formatX = (value: number) => `${value.toFixed(2).padStart(5)}x`;

const runtime = bun ? `bun ${bun.version}` : `node ${process.version}`;

console.log(`Runtime: ${runtime}`);
console.log(
  `Method: ${samples} interleaved samples, ${warmupFrames} warmup frames, ${measureFrames} measured frames, forced GC between samples`,
);

let maxFgDiff = 0;
let maxBgDiff = 0;
for (const scenario of scenarios) {
  const verified = verifyScenario(scenario);
  maxFgDiff = Math.max(maxFgDiff, verified.maxFgDiff);
  maxBgDiff = Math.max(maxBgDiff, verified.maxBgDiff);
}

console.log(
  `Verification: passed across ${scenarios.length} scenarios and ${verifyFrames} frames per scenario (max fg ${maxFgDiff.toExponential(2)}, max bg ${maxBgDiff.toExponential(2)})`,
);
console.log("");
console.log("Median time per frame, lower is better");

type Row = {
  name: string;
  baseline: Summary;
  current: Summary;
};

const rows: Row[] = [];
let totalBaseline = 0;
let totalCurrent = 0;

for (const scenario of scenarios) {
  const { baseline, current } = measurePair(scenario);

  rows.push({ name: scenario.name, baseline, current });
  totalBaseline += baseline.median;
  totalCurrent += current.median;
}

for (const row of rows) {
  const speedup = row.baseline.median / row.current.median;
  console.log(
    `${row.name.padEnd(20)}  ${formatUs(row.baseline.median)}  ${formatUs(row.current.median)}  ${formatX(speedup)}  cv ${formatPct(row.baseline.cv)}/${formatPct(row.current.cv)}`,
  );
}

console.log("");
console.log(
  `Composite median: ${formatUs(totalBaseline)} -> ${formatUs(totalCurrent)} (${formatX(totalBaseline / totalCurrent)})`,
);
console.log(`Checksum: ${sink.toFixed(3)}`);
