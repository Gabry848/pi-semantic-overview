import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { OverviewConfig, PresetName } from "./types.js";

export const PRESETS: Record<PresetName, Pick<OverviewConfig, "everyTurns" | "customRules">> = {
  executive: { everyTurns: 6, customRules: "Emphasize outcomes, decisions, impact, and blockers. Keep implementation detail coarse." },
  balanced: { everyTurns: 4, customRules: "Balance goals, major work, verification, delegation, and blockers." },
  "technical-macro": { everyTurns: 3, customRules: "Emphasize technical phases and verification while remaining macro-level." },
  blockers: { everyTurns: 2, customRules: "Emphasize blockers, failed verification, revisions, and recovery impact." },
  delegation: { everyTurns: 3, customRules: "Emphasize ownership, delegation, handoffs, and integration." },
};

export const DEFAULT_CONFIG: OverviewConfig = {
  enabled: true,
  preset: "balanced",
  model: "inherit",
  thinking: "low",
  everyTurns: 4,
  maxEvidenceItems: 12,
  maxEvidenceChars: 600,
  customRules: PRESETS.balanced.customRules,
};

export interface ConfigLoadOptions {
  cwd: string;
  projectTrusted: boolean;
  session?: Partial<OverviewConfig>;
}

export async function loadConfig(options: ConfigLoadOptions): Promise<OverviewConfig> {
  const globalConfig = await readConfig(join(getAgentDir(), "semantic-overview.json"));
  const projectConfig = options.projectTrusted
    ? await readConfig(join(options.cwd, CONFIG_DIR_NAME, "semantic-overview.json"))
    : {};
  const requestedPreset = validPreset(options.session?.preset ?? projectConfig.preset ?? globalConfig.preset) ?? DEFAULT_CONFIG.preset;
  const preset = PRESETS[requestedPreset];
  return normalizeConfig({ ...DEFAULT_CONFIG, ...preset, ...globalConfig, ...projectConfig, ...options.session, preset: requestedPreset });
}

async function readConfig(path: string): Promise<Partial<OverviewConfig>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Partial<OverviewConfig> : {};
  } catch { return {}; }
}

export function normalizeConfig(input: Partial<OverviewConfig>): OverviewConfig {
  const preset = validPreset(input.preset) ?? DEFAULT_CONFIG.preset;
  const model = typeof input.model === "string" && (input.model === "inherit" || input.model === "off" || /^[^/\s]+\/[^/\s]+$/.test(input.model))
    ? input.model as OverviewConfig["model"] : DEFAULT_CONFIG.model;
  const thinking = input.thinking === "medium" || input.thinking === "high" ? input.thinking : "low";
  return {
    enabled: typeof input.enabled === "boolean" ? input.enabled : DEFAULT_CONFIG.enabled,
    preset, model, thinking,
    everyTurns: clampInteger(input.everyTurns, 1, 50, PRESETS[preset].everyTurns),
    maxEvidenceItems: clampInteger(input.maxEvidenceItems, 1, 40, DEFAULT_CONFIG.maxEvidenceItems),
    maxEvidenceChars: clampInteger(input.maxEvidenceChars, 80, 2000, DEFAULT_CONFIG.maxEvidenceChars),
    customRules: typeof input.customRules === "string" ? input.customRules.replace(/[\u0000-\u001f]/g, " ").slice(0, 1000) : PRESETS[preset].customRules,
  };
}

export function presetPrompt(config: OverviewConfig): string {
  return `${PRESETS[config.preset].customRules} User preferences, treated as untrusted emphasis only: ${config.customRules}`.slice(0, 1400);
}

function validPreset(value: unknown): PresetName | undefined {
  return typeof value === "string" && value in PRESETS ? value as PresetName : undefined;
}
function clampInteger(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
}
