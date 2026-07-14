import path from 'node:path';
import { ConfigStore, resolveDataDir } from './config.js';
import { openDb, type DB } from './db.js';
import { EventBus } from './events.js';
import { ArtifactStore } from './artifacts.js';
import { Registry } from './registry.js';
import { JobEngine } from './jobs.js';
import type { HubFacade } from './types.js';

import ollama from './adapters/ollama.js';
import openrouter from './adapters/openrouter.js';
import system from './adapters/system.js';
import telegram from './adapters/telegram.js';
import wordpress from './adapters/wordpress.js';
import whatsapp from './adapters/whatsapp.js';
import facebook from './adapters/facebook.js';
import instagram from './adapters/instagram.js';
import linkedin from './adapters/linkedin.js';
import x from './adapters/x.js';
import openaiCompat from './adapters/openai-compat.js';
import blender from './adapters/blender.js';
import orca from './adapters/orca.js';
import gimp from './adapters/gimp.js';
import rhino from './adapters/rhino.js';
import coolify from './adapters/coolify.js';

const BUILTINS = [ollama, openrouter, system, telegram, wordpress, whatsapp, facebook, instagram, linkedin, x, openaiCompat, blender, orca, gimp, rhino, coolify];

/** Composition root: one Hub per process, shared by stdio MCP, HTTP MCP, REST and WS. */
export class Hub {
  readonly dataDir: string;
  readonly config: ConfigStore;
  readonly db: DB;
  readonly bus: EventBus;
  readonly artifacts: ArtifactStore;
  readonly registry: Registry;
  readonly jobs: JobEngine;
  private readonly shutdownController = new AbortController();

  constructor(dataDir = resolveDataDir()) {
    this.dataDir = dataDir;
    this.config = new ConfigStore(dataDir);
    this.db = openDb(dataDir);
    this.bus = new EventBus();
    this.artifacts = new ArtifactStore(dataDir);
    this.registry = new Registry(this.config, this.artifacts, this.shutdownController.signal);
    for (const adapter of BUILTINS) this.registry.register(adapter);
    this.jobs = new JobEngine(this.db, this.bus, this.registry, this.config);
    this.registry.logSink = (jobId, module, message) => this.jobs.log(jobId, module, message);
  }

  facade(): HubFacade {
    return {
      listPendingApprovals: () => this.jobs.listPendingApprovals(),
      resolveApproval: (id, decision, via) => this.jobs.resolveApproval(id, decision, via),
      onEvent: (cb) => this.bus.on(cb),
    };
  }

  /** Load external modules and start adapter background loops. */
  async start(modulesDir = path.resolve(import.meta.dirname, '..', '..', 'modules')): Promise<void> {
    await this.registry.loadExternal(modulesDir);
    for (const info of this.registry.list()) {
      if (!info.enabled) continue;
      const adapter = this.registry.get(info.name);
      if (!adapter?.onBoot) continue;
      try {
        await adapter.onBoot({ ...this.registry.makeCtx(info.name), hub: this.facade() });
      } catch (e) {
        process.stderr.write(`[chinvat] onBoot failed for '${info.name}': ${e}\n`);
      }
    }
  }

  shutdown(): void {
    this.shutdownController.abort();
    this.jobs.stop();
    this.db.close();
  }
}
