import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  AdapterContext,
  ChinvatAdapter,
  HealthStatus,
  OperationSpec,
} from './types.js';
import type { ConfigStore } from './config.js';
import type { ArtifactStore } from './artifacts.js';

export interface ModuleInfo {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  tier: string;
  external: boolean;
  operations: OperationSpec[];
}

const HEALTH_TTL_MS = 30_000;

export class Registry {
  private adapters = new Map<string, { adapter: ChinvatAdapter; external: boolean }>();
  private healthCache = new Map<string, { ts: number; status: HealthStatus }>();
  /** Set by the hub so adapter logs land in job_events; defaults to stderr. */
  logSink: (jobId: string | undefined, module: string, message: string) => void = (
    _jobId,
    module,
    message
  ) => process.stderr.write(`[${module}] ${message}\n`);

  constructor(
    private readonly config: ConfigStore,
    private readonly artifacts: ArtifactStore,
    readonly shutdownSignal: AbortSignal
  ) {}

  register(adapter: ChinvatAdapter, external = false): void {
    this.adapters.set(adapter.name, { adapter, external });
    this.config.module(adapter.name); // materialize settings with defaults
  }

  async loadExternal(modulesDir: string): Promise<void> {
    if (!fs.existsSync(modulesDir)) return;
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = path.join(modulesDir, entry.name);
      const candidate = ['index.mjs', 'index.js']
        .map((f) => path.join(base, f))
        .find((f) => fs.existsSync(f));
      if (!candidate) continue;
      try {
        const mod = await import(pathToFileURL(candidate).href);
        const adapter: ChinvatAdapter = mod.default ?? mod.adapter;
        if (adapter?.name && typeof adapter.invoke === 'function') {
          this.register(adapter, true);
          process.stderr.write(`[chinvat] loaded external module '${adapter.name}'\n`);
        }
      } catch (e) {
        process.stderr.write(`[chinvat] failed to load module ${entry.name}: ${e}\n`);
      }
    }
  }

  get(name: string): ChinvatAdapter | undefined {
    return this.adapters.get(name)?.adapter;
  }

  isEnabled(name: string): boolean {
    return this.adapters.has(name) && this.config.module(name).enabled;
  }

  operation(module: string, op: string): OperationSpec | undefined {
    return this.get(module)
      ?.capabilities()
      .find((o) => o.name === op);
  }

  list(): ModuleInfo[] {
    return [...this.adapters.entries()].map(([name, { adapter, external }]) => {
      const settings = this.config.module(name);
      return {
        name,
        version: adapter.version,
        description: adapter.description,
        enabled: settings.enabled,
        tier: settings.tier,
        external,
        operations: adapter.capabilities(),
      };
    });
  }

  makeCtx(module: string, jobId?: string, signal?: AbortSignal): AdapterContext {
    const settings = this.config.module(module);
    return {
      config: settings.config,
      dataDir: this.config.dataDir,
      jobId,
      saveArtifact: (name, content) => this.artifacts.save(jobId ?? 'adhoc', name, content),
      log: (message) => this.logSink(jobId, module, message),
      signal: signal ?? this.shutdownSignal,
    };
  }

  async health(name: string, force = false): Promise<HealthStatus> {
    const adapter = this.get(name);
    if (!adapter) return { ok: false, detail: 'unknown module' };
    const cached = this.healthCache.get(name);
    if (!force && cached && Date.now() - cached.ts < HEALTH_TTL_MS) return cached.status;
    let status: HealthStatus;
    try {
      status = await adapter.health(this.makeCtx(name));
    } catch (e) {
      status = { ok: false, detail: String(e instanceof Error ? e.message : e) };
    }
    this.healthCache.set(name, { ts: Date.now(), status });
    return status;
  }
}
