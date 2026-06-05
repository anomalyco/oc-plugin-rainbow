/** @jsxImportSource @opentui/solid */
import { TargetChannel, type OptimizedBuffer } from "@opentui/core";
import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import { createSignal } from "solid-js";
import { LogoScreen } from "./logo-screen";
import { createRainbowPostProcess } from "./rainbow-post-process";
import {
  SettingsDialog,
  createSettingKey,
  type Field,
  type NumberField,
  type SettingsState,
  type ToggleField,
} from "./settings-dialog";

const id = "tui-rainbow";
const speed = 0.008;
const turns = 3;
const glow = 0.05;
const splashRoute = `${id}.logo`;
const splashCommand = `${id}.logo-splash`;
const splashFadeInMs = 1050;
const splashPeakHoldMs = 34;
const splashFadeOutMs = 100;
const splashKeybind = "ctrl+shift+r";
const rainbowMinFps = 12;
const rainbowMaxFps = 24;
const rainbowPhaseStep = 0.05;

type SplashPhase = "idle" | "fade-in" | "hold" | "fade-out";
type SplashState = {
  phase: SplashPhase;
  elapsed: number;
  queued: boolean;
};

type Api = Parameters<TuiPlugin>[0];
type Cfg = SettingsState;

const setting = createSettingKey(id);

const clamp = (value: number, min: number, max: number) => {
  if (value < min) return min;
  if (value > max) return max;
  return value;
};

const num = (value: unknown, fallback: number) => {
  if (typeof value !== "number") return fallback;
  return value;
};

const bool = (value: unknown, fallback: boolean) => {
  if (typeof value !== "boolean") return fallback;
  return value;
};

const splashFadeIn = (t: number) => {
  const split = 0.78;
  const base = 0.16;
  if (t <= 0) return 0;
  if (t < split) {
    const head = t / split;
    return base * head * head;
  }
  if (t >= 1) return 1;
  const tail = (t - split) / (1 - split);
  return base + (1 - base) * 2 ** (10 * tail - 10);
};

const splashFadeOut = (t: number) => {
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  const left = 1 - t;
  return left * left * left;
};

const whiteMatrix = new Float32Array(16);

const setWhiteMatrix = (strength: number) => {
  const keep = 1 - strength;
  whiteMatrix[0] = keep;
  whiteMatrix[1] = 0;
  whiteMatrix[2] = 0;
  whiteMatrix[3] = strength;
  whiteMatrix[4] = 0;
  whiteMatrix[5] = keep;
  whiteMatrix[6] = 0;
  whiteMatrix[7] = strength;
  whiteMatrix[8] = 0;
  whiteMatrix[9] = 0;
  whiteMatrix[10] = keep;
  whiteMatrix[11] = strength;
  whiteMatrix[12] = 0;
  whiteMatrix[13] = 0;
  whiteMatrix[14] = 0;
  whiteMatrix[15] = 1;
};

const anim = (cfg: Cfg) => {
  return cfg.speed > 0 && (cfg.fg || (cfg.bg && cfg.glow > 0));
};

const rainbowFrameMs = (cfg: Cfg) => {
  const phaseRate = cfg.speed * (cfg.fg ? 0.1 : 0.04);
  if (phaseRate <= 0) return 1000 / rainbowMinFps;
  return clamp(rainbowPhaseStep / phaseRate, 1000 / rainbowMaxFps, 1000 / rainbowMinFps);
};

const cfg = (opts: Record<string, unknown> | undefined): Cfg => {
  return {
    fg: bool(opts?.fg, true),
    bg: bool(opts?.bg, true),
    speed: clamp(num(opts?.speed, speed), 0, 0.03),
    turns: clamp(num(opts?.turns, turns), 0.25, 8),
    glow: clamp(num(opts?.glow, glow), 0, 0.15),
  };
};

const load = (api: Api, value: Cfg): Cfg => {
  return {
    fg: bool(api.kv.get(setting.fg, value.fg), value.fg),
    bg: bool(api.kv.get(setting.bg, value.bg), value.bg),
    speed: clamp(num(api.kv.get(setting.speed, value.speed), value.speed), 0, 0.03),
    turns: clamp(num(api.kv.get(setting.turns, value.turns), value.turns), 0.25, 8),
    glow: clamp(num(api.kv.get(setting.glow, value.glow), value.glow), 0, 0.15),
  };
};

const tui: TuiPlugin = async (api, options) => {
  if (options?.enabled === false) return;

  const [value, setValue] = createSignal(load(api, cfg(options)));
  const apply: (buffer: OptimizedBuffer, delta: number) => void = createRainbowPostProcess(
    () => api.theme.current,
    value,
  );
  const splash: SplashState = {
    phase: "idle",
    elapsed: 0,
    queued: false,
  };
  let live = false;
  let disposed = false;
  let rainbowTimer: ReturnType<typeof setTimeout> | undefined;

  const splashLive = () => splash.phase !== "idle";

  const clearRainbowTimer = () => {
    if (rainbowTimer === undefined) return;
    clearTimeout(rainbowTimer);
    rainbowTimer = undefined;
  };

  // Keep the ambient effect on one-shot renders instead of a continuous live loop.
  const scheduleRainbow = (cfg = value()) => {
    if (disposed || splashLive() || !anim(cfg) || rainbowTimer !== undefined) return;
    rainbowTimer = setTimeout(() => {
      rainbowTimer = undefined;
      if (disposed || splashLive()) return;
      const next = value();
      if (!anim(next)) return;
      api.renderer.requestRender();
      scheduleRainbow(next);
    }, rainbowFrameMs(cfg));
  };

  const sync = (cfg = value()) => {
    const nextLive = splashLive();
    if (nextLive && !live) {
      api.renderer.requestLive();
      live = true;
    }
    if (!nextLive && live) {
      api.renderer.dropLive();
      live = false;
    }

    clearRainbowTimer();
    if (!nextLive && anim(cfg)) {
      scheduleRainbow(cfg);
    }
  };

  const startSplash = () => {
    if (splash.phase !== "idle") return;
    const current = api.route.current;
    if (current.name === splashRoute) return;
    api.ui.dialog.clear();
    splash.phase = "fade-in";
    splash.elapsed = 0;
    splash.queued = false;
    sync();
    api.renderer.requestRender();
  };

  const leaveSplash = () => {
    splash.phase = "idle";
    splash.elapsed = 0;
    splash.queued = false;
    api.route.navigate("home");
    sync();
    api.renderer.requestRender();
  };

  const fadeToLogo = (buffer: OptimizedBuffer, delta: number) => {
    if (splash.phase === "idle") return;
    splash.elapsed += delta;

    let strength = 0;
    if (splash.phase === "fade-in") {
      const t = clamp(splash.elapsed / splashFadeInMs, 0, 1);
      strength = splashFadeIn(t);
      if (t >= 1 && !splash.queued) {
        splash.phase = "hold";
        splash.elapsed = 0;
        splash.queued = true;
        queueMicrotask(() => {
          if (disposed) return;
          api.route.navigate(splashRoute);
          splash.queued = false;
          sync();
          api.renderer.requestRender();
        });
      }
    } else if (splash.phase === "hold") {
      strength = 1;
      if (splash.elapsed >= splashPeakHoldMs) {
        splash.phase = "fade-out";
        splash.elapsed = 0;
      }
    } else {
      const t = clamp(splash.elapsed / splashFadeOutMs, 0, 1);
      strength = splashFadeOut(t);
      if (t >= 1) {
        splash.phase = "idle";
        splash.elapsed = 0;
        splash.queued = false;
        sync();
        return;
      }
    }

    if (strength <= 0) return;
    setWhiteMatrix(strength);
    buffer.colorMatrixUniform(whiteMatrix, 1, TargetChannel.Both);
  };

  api.route.register([
    {
      name: splashRoute,
      render() {
        return <LogoScreen theme={() => api.theme.current} onExit={leaveSplash} />;
      },
    },
  ]);

  const save = <K extends Field>(key: K, next: Cfg[K]) => {
    const prev = value();
    if (prev[key] === next) return;
    const state = { ...prev, [key]: next } as Cfg;
    setValue(state);
    api.kv.set(setting[key], next);
    sync(state);
  };

  const flip = (key: ToggleField) => {
    save(key, !value()[key]);
  };

  const tune = (key: NumberField, dir: -1 | 1) => {
    const step = key === "speed" ? 0.001 : key === "turns" ? 0.25 : 0.01;
    const min = key === "speed" ? 0 : key === "turns" ? 0.25 : 0;
    const max = key === "speed" ? 0.03 : key === "turns" ? 8 : 0.15;
    const digits = key === "speed" ? 3 : 2;
    save(key, Number(clamp(value()[key] + step * dir, min, max).toFixed(digits)));
  };

  const show = () => {
    api.ui.dialog.setSize("medium");
    api.ui.dialog.replace(() => <SettingsDialog api={api} value={value} flip={flip} tune={tune} />);
  };

  api.renderer.addPostProcessFn(apply);
  api.renderer.addPostProcessFn(fadeToLogo);
  sync();

  api.command.register(() => [
    {
      title: "Show logo splash",
      value: splashCommand,
      keybind: splashKeybind,
      category: "Plugin",
      description: "Fade to white and reveal a centered OpenCode logo screen",
      onSelect() {
        startSplash();
      },
    },
    {
      title: "Rainbow settings",
      value: `${id}.settings`,
      category: "Plugin",
      slash: {
        name: "rainbow-settings",
      },
      onSelect() {
        show();
      },
    },
  ]);

  api.lifecycle.onDispose(() => {
    disposed = true;
    clearRainbowTimer();
    api.renderer.removePostProcessFn(apply);
    api.renderer.removePostProcessFn(fadeToLogo);
    if (live) {
      api.renderer.dropLive();
      live = false;
    }
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
};

export default plugin;
