import fs from 'node:fs';
import path from 'node:path';
import type { Tier } from './types.js';

export interface ModuleSettings {
  enabled: boolean;
  tier: Tier;
  config: Record<string, unknown>;
}

export interface ChinvatConfig {
  port: number;
  bind: string;
  /**
   * Bearer token required on /mcp and /api. Empty is allowed only while `bind`
   * is loopback; a non-loopback bind without a token is a startup error.
   * See hub/src/auth.ts and docs/REMOTE-NODES.md.
   */
  authToken: string;
  concurrencyPerModule: number;
  syncWaitMsDefault: number;
  syncWaitMsMax: number;
  /** Modules whose read-risk operations may be invoked with ephemeral:true (no persistence). */
  ephemeralModules: string[];
  modules: Record<string, ModuleSettings>;
}

const DEFAULT_TIERS: Record<string, Tier> = {
  ollama: 'autonomous',
  openrouter: 'autonomous',
  system: 'approve',
  telegram: 'approve',
  wordpress: 'approve',
  woocommerce: 'approve',
  whatsapp: 'approve',
  facebook: 'approve',
  instagram: 'approve',
  linkedin: 'approve',
  x: 'approve',
  coolify: 'approve',
  'openai-compatible': 'autonomous',
  gmail: 'approve',
  'chat-relay': 'approve',
  'remote-node': 'approve',
};

const DEFAULT_ENABLED = new Set(['ollama', 'openrouter', 'system', 'telegram', 'wordpress']);

export function defaultModuleSettings(name: string): ModuleSettings {
  return {
    enabled: DEFAULT_ENABLED.has(name),
    tier: DEFAULT_TIERS[name] ?? 'approve',
    config: {},
  };
}

export function resolveDataDir(): string {
  if (process.env.CHINVAT_DATA_DIR) return path.resolve(process.env.CHINVAT_DATA_DIR);
  // repo root /data (hub/dist/config.js -> ../../data) or cwd/data as fallback
  const repoData = path.resolve(import.meta.dirname, '..', '..', 'data');
  return repoData;
}

export class ConfigStore {
  readonly file: string;
  private cfg: ChinvatConfig;

  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'chinvat.config.json');
    this.cfg = this.load();
  }

  private load(): ChinvatConfig {
    let raw: Partial<ChinvatConfig> = {};
    if (fs.existsSync(this.file)) {
      try {
        raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      } catch (e) {
        process.stderr.write(`[chinvat] config parse error, using defaults: ${e}\n`);
      }
    }
    const cfg: ChinvatConfig = {
      port: Number(process.env.CHINVAT_PORT ?? raw.port ?? 7777),
      bind: process.env.CHINVAT_BIND ?? raw.bind ?? '127.0.0.1',
      authToken: String(process.env.CHINVAT_AUTH_TOKEN ?? raw.authToken ?? ''),
      concurrencyPerModule: raw.concurrencyPerModule ?? 2,
      syncWaitMsDefault: raw.syncWaitMsDefault ?? 120_000,
      syncWaitMsMax: raw.syncWaitMsMax ?? 600_000,
      ephemeralModules: Array.isArray(raw.ephemeralModules)
        ? raw.ephemeralModules.map(String)
        : ['ollama'],
      modules: raw.modules ?? {},
    };
    return cfg;
  }

  get(): ChinvatConfig {
    return this.cfg;
  }

  module(name: string): ModuleSettings {
    if (!this.cfg.modules[name]) {
      this.cfg.modules[name] = defaultModuleSettings(name);
      this.save();
    }
    return this.cfg.modules[name];
  }

  updateModule(name: string, patch: Partial<ModuleSettings>): ModuleSettings {
    const cur = this.module(name);
    if (patch.config) cur.config = { ...cur.config, ...patch.config };
    if (patch.tier) cur.tier = patch.tier;
    if (typeof patch.enabled === 'boolean') cur.enabled = patch.enabled;
    this.save();
    return cur;
  }

  save(): void {
    fs.writeFileSync(this.file, JSON.stringify(this.cfg, null, 2));
  }
}
