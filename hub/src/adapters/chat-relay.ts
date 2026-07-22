/**
 * Chat-relay orchestrator — the human-gated coding relay
 * (docs/DESIGN-mail-relay.md). It compiles a repo packet, hands it to a
 * chatbot session through a pluggable transport (mail / clipboard / file),
 * imports the reply, validates it in a disposable worktree, and gates the
 * apply behind policy.
 *
 * This adapter owns lifecycle STATE (under dataDir/relay/<task-id>/) but owns
 * no network transport itself: the mail carrier is the separate `gmail`
 * module, which the coordinator composes as a child job. That keeps the relay
 * provider-neutral — swap gmail for clipboard and nothing else changes.
 *
 * Risk mapping (per docs §Risk):
 *   read  — relay_create / relay_import / relay_status / relay_list / relay_repair
 *           (compile, parse, inspect: no execution, no egress, no mutation)
 *   act   — relay_dispatch (bytes leave the machine)
 *           relay_validate (runs the packet's validation commands)
 *           relay_reject (tears down the scratch worktree/branch)
 *   dangerous — relay_apply (mutates the live branch)
 * At the default `approve` tier this yields: compile/import free; one click to
 * dispatch, one to validate, one to apply.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AdapterError } from '../types.js';
import type { AdapterContext, ChinvatAdapter, InvokeResult } from '../types.js';
import { msg } from './util.js';
import {
  compilePacket,
  type Classification,
  type Lane,
  type PacketRequest,
} from '../lib/repo-packet.js';
import {
  emitReturnInstructions,
  parse as parseEnvelope,
  verify as verifyEnvelope,
  type OutputType,
  type ParsedResponse,
} from '../lib/relay-envelope.js';
import {
  validateInWorktree,
  applyToLive,
  cleanup as cleanupWorktree,
  baseCommitPresent,
  type ValidationReport,
} from '../lib/relay-worktree.js';

type Transport = 'mail' | 'clipboard' | 'file';
type State =
  | 'compiled'
  | 'dispatched'
  | 'imported'
  | 'validated_pass'
  | 'validated_fail'
  | 'applied'
  | 'rejected';

interface Manifest {
  task_id: string;
  task: string;
  repo_path: string;
  lane: Lane;
  deliverable: OutputType;
  transport?: Transport;
  base_commit: string;
  branch: string;
  packet_sha: string;
  classification: Classification;
  included_paths: string[];
  validation_commands: string[];
  return_to: string;
  state: State;
  repair_count: number;
  created_at: number;
  dispatched_at?: number;
  imported_at?: number;
  validated_at?: number;
  applied_at?: number;
  notes: string[];
}

const OUTPUT_TYPES: OutputType[] = ['PLAN', 'UNIFIED_DIFF', 'REVIEW', 'FILE_SET'];
const LANES: Lane[] = ['chatgpt', 'gemini', 'generic'];
const MAX_REPAIRS = 2;

function relayRoot(ctx: AdapterContext): string {
  return path.join(ctx.dataDir, 'relay');
}
function taskDir(ctx: AdapterContext, id: string): string {
  if (!/^CR-\d{4}-\d{4}$/.test(id)) throw new AdapterError(`bad task id: ${id}`);
  return path.join(relayRoot(ctx), id);
}
function manifestPath(ctx: AdapterContext, id: string): string {
  return path.join(taskDir(ctx, id), 'manifest.json');
}
function readManifest(ctx: AdapterContext, id: string): Manifest {
  const p = manifestPath(ctx, id);
  if (!fs.existsSync(p)) throw new AdapterError(`no such relay task: ${id}`);
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Manifest;
}
function writeManifest(ctx: AdapterContext, m: Manifest): void {
  const dir = taskDir(ctx, m.task_id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(manifestPath(ctx, m.task_id), JSON.stringify(m, null, 2), 'utf8');
}

function nextTaskId(ctx: AdapterContext): string {
  const year = new Date().getFullYear();
  const root = relayRoot(ctx);
  fs.mkdirSync(root, { recursive: true });
  const prefix = `CR-${year}-`;
  const existing = fs
    .readdirSync(root)
    .filter((d) => d.startsWith(prefix))
    .map((d) => Number(d.slice(prefix.length)))
    .filter((n) => Number.isFinite(n));
  const seq = (existing.length ? Math.max(...existing) : 0) + 1;
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

const adapter: ChinvatAdapter = {
  name: 'chat-relay',
  version: '0.1.0',
  description:
    'Human-gated coding relay: compile a repo packet, hand it to a chatbot session (mail/clipboard/file), import + validate the reply in an isolated worktree, apply behind approval. Provider-neutral; pairs with the gmail module for the mail lane.',
  activation: {
    kind: 'service',
    note: 'Enable, then set a return address. Mail lane also needs the gmail module configured. See docs/DESIGN-mail-relay.md.',
    guide: 'docs/DESIGN-mail-relay.md',
  },
  configSchema: [
    { key: 'return_to', label: 'Default return address / instruction', type: 'string', placeholder: 'you@example.com', help: 'Where the chatbot sends/drafts its reply (mail lane), or a note for manual lanes.' },
    { key: 'default_lane', label: 'Default lane', type: 'string', default: 'generic', help: 'chatgpt | gemini | generic' },
    { key: 'import_dir', label: 'Watched response drop dir (file transport)', type: 'string', placeholder: 'C:\\chinvat\\relay-inbox' },
  ],

  capabilities: () => [
    {
      name: 'relay_create',
      description:
        'Compile a repo packet for a task. Runs the secret firewall and classification; refuses on SECRET hits or over the asserted ceiling. Returns task_id, packet_sha, classification.',
      risk: 'read',
      params: {
        task: { type: 'string', description: 'Exact desired result', required: true },
        repo_path: { type: 'string', description: 'Absolute path to the git repo', required: true },
        deliverable: { type: 'string', description: 'PLAN | UNIFIED_DIFF | REVIEW | FILE_SET (default FILE_SET)' },
        lane: { type: 'string', description: 'chatgpt | gemini | generic' },
        include_files: { type: 'array', description: 'Files/dirs to embed as EVIDENCE (repo-relative)' },
        hypothesis: { type: 'string', description: 'Optional diagnosis to seed the model' },
        validation_commands: { type: 'array', description: 'Shell commands that constitute acceptance' },
        max_classification: { type: 'string', description: 'PUBLIC|INTERNAL|CONFIDENTIAL|SECRET ceiling (default CONFIDENTIAL)' },
      },
    },
    {
      name: 'relay_dispatch',
      description:
        'Mark a packet dispatched over a transport. mail → returns {to,subject,body} for a gmail.send_mail child job. clipboard/file → returns the packet text for the operator to paste. Bytes leaving the machine is the gated action.',
      risk: 'act',
      params: {
        task_id: { type: 'string', required: true },
        transport: { type: 'string', description: 'mail | clipboard | file (default clipboard)' },
      },
    },
    {
      name: 'relay_import',
      description:
        'Import a raw chatbot reply (response_text or response_file). Parses the envelope and verifies TASK_ID + PACKET_SHA + BASE_COMMIT. Rejects truncated/mismatched replies. No execution.',
      risk: 'read',
      params: {
        task_id: { type: 'string', required: true },
        response_text: { type: 'string', description: 'Raw reply text (from clipboard/paste-box/mail body)' },
        response_file: { type: 'string', description: 'Path to a file containing the raw reply' },
      },
    },
    {
      name: 'relay_validate',
      description:
        'Apply the imported reply in a disposable worktree at BASE_COMMIT and run the packet validation commands. Returns pass/fail with per-step tails and the diff.',
      risk: 'act',
      params: { task_id: { type: 'string', required: true } },
    },
    {
      name: 'relay_apply',
      description: 'Apply a validated relay result onto the live branch (fails if HEAD moved off base). Mutates the working repo.',
      risk: 'dangerous',
      params: { task_id: { type: 'string', required: true } },
    },
    {
      name: 'relay_repair',
      description:
        'Compile a delta packet (task + failing output + validation tail) for re-dispatch, up to a repair cap. Returns the new packet.',
      risk: 'read',
      params: { task_id: { type: 'string', required: true } },
    },
    {
      name: 'relay_reject',
      description: 'Discard a relay result and tear down its scratch worktree/branch.',
      risk: 'act',
      params: { task_id: { type: 'string', required: true } },
    },
    {
      name: 'relay_status',
      description: 'Full manifest + validation summary for one task.',
      risk: 'read',
      params: { task_id: { type: 'string', required: true } },
    },
    {
      name: 'relay_list',
      description: 'List relay tasks with state and classification.',
      risk: 'read',
      params: { state: { type: 'string', description: 'Optional state filter' } },
    },
  ],

  async health(ctx) {
    const root = relayRoot(ctx);
    const n = fs.existsSync(root) ? fs.readdirSync(root).filter((d) => /^CR-/.test(d)).length : 0;
    const ret = ctx.config.return_to ? String(ctx.config.return_to) : '';
    return {
      ok: true,
      detail: `${n} relay task(s)${ret ? ` · return_to ${ret}` : ' · no return_to set'}`,
    };
  },

  async invoke(operation, args, ctx): Promise<InvokeResult> {
    switch (operation) {
      case 'relay_create': {
        const deliverable = pick(args.deliverable, OUTPUT_TYPES, 'FILE_SET') as OutputType;
        const lane = pick(args.lane ?? ctx.config.default_lane, LANES, 'generic') as Lane;
        const req: PacketRequest = {
          task: reqStr(args, 'task'),
          repoPath: reqStr(args, 'repo_path'),
          deliverable,
          lane,
          includeFiles: strArray(args.include_files),
          hypothesis: args.hypothesis ? String(args.hypothesis) : undefined,
          validationCommands: strArray(args.validation_commands),
          maxClassification: args.max_classification
            ? (String(args.max_classification).toUpperCase() as Classification)
            : undefined,
        };
        const result = compilePacket(req);
        const id = nextTaskId(ctx);
        const returnTo = ctx.config.return_to ? String(ctx.config.return_to) : '(set return_to in config)';
        const manifest: Manifest = {
          task_id: id,
          task: req.task,
          repo_path: path.resolve(req.repoPath),
          lane,
          deliverable,
          base_commit: result.baseCommit,
          branch: result.branch,
          packet_sha: result.packetSha,
          classification: result.classification,
          included_paths: result.includedPaths,
          validation_commands: req.validationCommands ?? [],
          return_to: returnTo,
          state: 'compiled',
          repair_count: 0,
          created_at: Date.now(),
          notes: result.notes,
        };
        writeManifest(ctx, manifest);
        const dir = taskDir(ctx, id);
        const fullPacket =
          result.packet +
          '\n\n' +
          emitReturnInstructions({
            taskId: id,
            baseCommit: result.baseCommit,
            packetSha: result.packetSha,
            outputType: deliverable,
            returnTo,
          });
        fs.writeFileSync(path.join(dir, 'relay_packet.md'), fullPacket, 'utf8');
        await ctx.saveArtifact('relay_packet.md', fullPacket);
        ctx.log(`compiled ${id} (${result.classification}, ${result.includedPaths.length} files, sha ${result.packetSha.slice(0, 12)})`);
        return {
          output: {
            task_id: id,
            packet_sha: result.packetSha,
            base_commit: result.baseCommit,
            classification: result.classification,
            included_files: result.includedPaths.length,
            notes: result.notes,
            packet_chars: fullPacket.length,
          },
        };
      }

      case 'relay_dispatch': {
        const id = reqStr(args, 'task_id');
        const m = readManifest(ctx, id);
        const transport = pick(args.transport, ['mail', 'clipboard', 'file'] as const, 'clipboard') as Transport;
        const packet = fs.readFileSync(path.join(taskDir(ctx, id), 'relay_packet.md'), 'utf8');
        m.transport = transport;
        m.state = 'dispatched';
        m.dispatched_at = Date.now();
        writeManifest(ctx, m);

        if (transport === 'mail') {
          const subject = `[CHINVAT ${id}]`;
          return {
            output: {
              task_id: id,
              transport,
              hint: 'submit a gmail.send_mail job with these fields, then prompt your chatbot to process the mail',
              to: m.return_to,
              subject,
              body: packet,
            },
          };
        }
        if (transport === 'file') {
          const outDir = ctx.config.import_dir ? String(ctx.config.import_dir) : taskDir(ctx, id);
          const outFile = path.join(outDir, `${id}.packet.md`);
          try {
            fs.mkdirSync(outDir, { recursive: true });
            fs.writeFileSync(outFile, packet, 'utf8');
          } catch (e) {
            throw new AdapterError(`could not write packet file: ${msg(e)}`);
          }
          return { output: { task_id: id, transport, packet_file: outFile } };
        }
        // clipboard: return the text; the coordinator/dashboard copies it.
        return { output: { task_id: id, transport, packet } };
      }

      case 'relay_import': {
        const id = reqStr(args, 'task_id');
        const m = readManifest(ctx, id);
        let raw = '';
        if (args.response_text) raw = String(args.response_text);
        else if (args.response_file) {
          const f = String(args.response_file);
          if (!fs.existsSync(f)) throw new AdapterError(`response_file not found: ${f}`);
          raw = fs.readFileSync(f, 'utf8');
        } else throw new AdapterError('relay_import needs response_text or response_file');

        const dir = taskDir(ctx, id);
        fs.writeFileSync(path.join(dir, 'response.raw.md'), raw, 'utf8');

        let parsed: ParsedResponse;
        try {
          parsed = parseEnvelope(raw);
        } catch (e) {
          m.state = 'rejected';
          m.notes.push(`import parse failed: ${msg(e)}`);
          writeManifest(ctx, m);
          throw new AdapterError(`import rejected: ${msg(e)}`);
        }
        const check = verifyEnvelope(parsed, {
          taskId: m.task_id,
          baseCommit: m.base_commit,
          packetSha: m.packet_sha,
          allowedPaths: m.included_paths.length ? m.included_paths : undefined,
        });
        fs.writeFileSync(path.join(dir, 'response.parsed.json'), JSON.stringify(parsed, null, 2), 'utf8');
        if (!check.ok) {
          m.state = 'rejected';
          m.notes.push(...check.problems.map((p) => `verify: ${p}`));
          writeManifest(ctx, m);
          return { output: { task_id: id, accepted: false, problems: check.problems } };
        }
        m.state = 'imported';
        m.imported_at = Date.now();
        writeManifest(ctx, m);
        const human_seconds = m.dispatched_at ? Math.round((m.imported_at - m.dispatched_at) / 1000) : null;
        return {
          output: {
            task_id: id,
            accepted: true,
            output_type: parsed.outputType,
            model_surface: parsed.modelSurface,
            files: parsed.files.map((f) => f.path),
            assumptions: parsed.assumptions,
            human_handling_seconds: human_seconds,
          },
        };
      }

      case 'relay_validate': {
        const id = reqStr(args, 'task_id');
        const m = readManifest(ctx, id);
        if (m.state !== 'imported' && m.state !== 'validated_fail')
          throw new AdapterError(`task ${id} is '${m.state}', expected 'imported'`);
        if (!baseCommitPresent(m.repo_path, m.base_commit))
          throw new AdapterError(`base commit ${m.base_commit.slice(0, 12)} missing from ${m.repo_path} — stale packet`);
        const parsed = JSON.parse(
          fs.readFileSync(path.join(taskDir(ctx, id), 'response.parsed.json'), 'utf8')
        ) as ParsedResponse;

        let report: ValidationReport;
        try {
          report = await validateInWorktree({
            repoPath: m.repo_path,
            taskId: id,
            baseCommit: m.base_commit,
            response: parsed,
            validationCommands: m.validation_commands,
            signal: ctx.signal,
          });
        } catch (e) {
          m.state = 'validated_fail';
          m.notes.push(`validate error: ${msg(e)}`);
          writeManifest(ctx, m);
          throw new AdapterError(`validation could not run: ${msg(e)}`);
        }

        const dir = taskDir(ctx, id);
        const log = [
          `task ${id} · base ${m.base_commit.slice(0, 12)}`,
          `changed files: ${report.changedFiles.join(', ') || '(none)'}`,
          '',
          ...report.steps.map((s) => `[${s.ok ? 'PASS' : 'FAIL'}] (${s.durationMs}ms) ${s.name}\n${s.tail}`),
          '',
          `problems: ${report.problems.join('; ') || 'none'}`,
        ].join('\n');
        fs.writeFileSync(path.join(dir, 'validation.log'), log, 'utf8');
        fs.writeFileSync(path.join(dir, 'proposed.patch'), report.diff, 'utf8');
        await ctx.saveArtifact('validation.log', log);

        m.state = report.ok ? 'validated_pass' : 'validated_fail';
        m.validated_at = Date.now();
        writeManifest(ctx, m);
        return {
          output: {
            task_id: id,
            passed: report.ok,
            changed_files: report.changedFiles,
            steps: report.steps.map((s) => ({ name: s.name, ok: s.ok, ms: s.durationMs })),
            problems: report.problems,
            worktree: report.worktree,
          },
        };
      }

      case 'relay_apply': {
        const id = reqStr(args, 'task_id');
        const m = readManifest(ctx, id);
        if (m.state !== 'validated_pass')
          throw new AdapterError(`task ${id} is '${m.state}', only 'validated_pass' can be applied`);
        const res = applyToLive({ repoPath: m.repo_path, taskId: id, baseCommit: m.base_commit });
        if (!res.applied) throw new AdapterError(`apply blocked: ${res.detail}`);
        m.state = 'applied';
        m.applied_at = Date.now();
        writeManifest(ctx, m);
        cleanupWorktree(m.repo_path, id);
        const decision = `APPLIED ${id} at ${new Date().toISOString()}\nhead: ${res.head}\n${res.detail}`;
        fs.writeFileSync(path.join(taskDir(ctx, id), 'decision.md'), decision, 'utf8');
        return { output: { task_id: id, applied: true, head: res.head, detail: res.detail } };
      }

      case 'relay_repair': {
        const id = reqStr(args, 'task_id');
        const m = readManifest(ctx, id);
        if (m.repair_count >= MAX_REPAIRS)
          throw new AdapterError(`repair cap (${MAX_REPAIRS}) reached for ${id} — reject and start fresh`);
        const dir = taskDir(ctx, id);
        const priorLog = fs.existsSync(path.join(dir, 'validation.log'))
          ? fs.readFileSync(path.join(dir, 'validation.log'), 'utf8').slice(-4000)
          : '(no validation log)';
        const priorResp = fs.existsSync(path.join(dir, 'response.raw.md'))
          ? fs.readFileSync(path.join(dir, 'response.raw.md'), 'utf8').slice(-8000)
          : '(no prior response)';
        const result = compilePacket({
          task:
            `${m.task}\n\n--- PRIOR ATTEMPT FAILED VALIDATION ---\n` +
            `Prior reply (truncated):\n${priorResp}\n\nValidation output:\n${priorLog}\n` +
            `Fix the failure. Same deliverable and constraints.`,
          repoPath: m.repo_path,
          deliverable: m.deliverable,
          lane: m.lane,
          validationCommands: m.validation_commands,
          maxClassification: m.classification,
        });
        m.repair_count += 1;
        m.packet_sha = result.packetSha;
        m.base_commit = result.baseCommit;
        m.state = 'compiled';
        writeManifest(ctx, m);
        const fullPacket =
          result.packet +
          '\n\n' +
          emitReturnInstructions({
            taskId: id,
            baseCommit: result.baseCommit,
            packetSha: result.packetSha,
            outputType: m.deliverable,
            returnTo: m.return_to,
          });
        fs.writeFileSync(path.join(dir, 'relay_packet.md'), fullPacket, 'utf8');
        return { output: { task_id: id, repair: m.repair_count, packet_sha: result.packetSha, packet_chars: fullPacket.length } };
      }

      case 'relay_reject': {
        const id = reqStr(args, 'task_id');
        const m = readManifest(ctx, id);
        cleanupWorktree(m.repo_path, id);
        m.state = 'rejected';
        writeManifest(ctx, m);
        fs.writeFileSync(path.join(taskDir(ctx, id), 'decision.md'), `REJECTED ${id} at ${new Date().toISOString()}`, 'utf8');
        return { output: { task_id: id, rejected: true } };
      }

      case 'relay_status': {
        const id = reqStr(args, 'task_id');
        const m = readManifest(ctx, id);
        const dir = taskDir(ctx, id);
        const validation = fs.existsSync(path.join(dir, 'validation.log'))
          ? fs.readFileSync(path.join(dir, 'validation.log'), 'utf8').slice(-2000)
          : undefined;
        return { output: { manifest: m, validation_tail: validation } };
      }

      case 'relay_list': {
        const root = relayRoot(ctx);
        const filter = args.state ? String(args.state) : '';
        if (!fs.existsSync(root)) return { output: { count: 0, tasks: [] } };
        const tasks = fs
          .readdirSync(root)
          .filter((d) => /^CR-\d{4}-\d{4}$/.test(d))
          .map((d) => {
            try {
              const m = readManifest(ctx, d);
              return { task_id: m.task_id, state: m.state, lane: m.lane, classification: m.classification, task: m.task.slice(0, 80) };
            } catch {
              return null;
            }
          })
          .filter((t): t is NonNullable<typeof t> => !!t && (!filter || t.state === filter));
        return { output: { count: tasks.length, tasks } };
      }

      default:
        throw new AdapterError(`unknown operation: ${operation}`);
    }
  },
};

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new AdapterError(`missing required arg '${key}'`);
  return v.trim();
}
function strArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return [v];
  return [];
}
function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = typeof v === 'string' ? (v.toUpperCase() as string) : '';
  const found = allowed.find((a) => a.toUpperCase() === s);
  return found ?? fallback;
}

export default adapter;
