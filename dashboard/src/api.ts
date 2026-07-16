import { useEffect, useRef, useState } from 'react';

export interface HealthStatus { ok: boolean; detail?: string }
export interface OperationSpec { name: string; description: string; risk: 'read' | 'act' | 'dangerous'; params: Record<string, any> }
export interface FieldSpec { key: string; label: string; type: 'string' | 'secret' | 'number' | 'boolean'; required?: boolean; placeholder?: string; help?: string; default?: any }
export interface ActivationSpec { kind: 'headless' | 'app-connect' | 'app-session' | 'service'; note: string; guide?: string }
export interface ModuleView {
  name: string; version: string; description: string; external: boolean;
  enabled: boolean; tier: 'observe' | 'approve' | 'autonomous';
  health: HealthStatus; activation: ActivationSpec | null;
  configSchema: FieldSpec[]; config: Record<string, any>; operations: OperationSpec[];
}
export interface Job {
  id: string; parent_id: string | null; module: string; operation: string;
  args: Record<string, any>; status: string; mode: string; result: any; error: string | null;
  created_at: number; started_at: number | null; finished_at: number | null; source: string;
}
export interface Approval { id: string; job_id: string; module: string; operation: string; args: Record<string, any>; requested_at: number }
export interface Status {
  name: string; version: string; platform: string; uptime_sec: number; endpoint: string;
  jobs: Record<string, number>; modules_enabled: number; modules_total: number; pending_approvals: number;
}
export interface ClientView {
  id: string; name: string; blurb: string; format: 'json' | 'toml' | 'yaml';
  transports: string[]; defaultTransport: string; scopes: string[]; restart: string; note?: string;
  autoInstall: boolean; globalPath: string | null; projectPath: string;
  detected: { installed: boolean; via: string };
  snippets: Record<string, string>; oneCommand?: Record<string, string>;
}
export interface EndpointTest { ok: boolean; url: string; detail: string; toolCount?: number; workerCount?: number; workers?: string[] }
export interface InstallPreview { clientId: string; transport: string; path: string; format: string; exists: boolean; before: string; after: string; backupPath: string | null; warning: string | null }
export interface InstallResult { path: string; backup: string | null; merged: boolean; warning: string | null }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
  return body as T;
}

export const api = {
  status: () => req<Status>('/status'),
  modules: () => req<ModuleView[]>('/modules'),
  setConfig: (name: string, config: Record<string, any>) =>
    req(`/modules/${name}/config`, { method: 'PUT', body: JSON.stringify({ config }) }),
  setTier: (name: string, tier: string) =>
    req(`/modules/${name}/tier`, { method: 'PUT', body: JSON.stringify({ tier }) }),
  setEnabled: (name: string, enabled: boolean) =>
    req(`/modules/${name}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled }) }),
  moduleTest: (name: string) => req<HealthStatus>(`/modules/${name}/test`, { method: 'POST' }),
  jobs: (q = '') => req<Job[]>(`/jobs${q}`),
  job: (id: string) => req<Job & { children: Job[]; events: any[]; artifacts: any[] }>(`/jobs/${id}`),
  submit: (body: any) => req<Job>('/jobs', { method: 'POST', body: JSON.stringify(body) }),
  cancel: (id: string) => req(`/jobs/${id}/cancel`, { method: 'POST' }),
  approvals: () => req<Approval[]>('/approvals'),
  approve: (id: string) => req(`/approvals/${id}/approve`, { method: 'POST' }),
  deny: (id: string) => req(`/approvals/${id}/deny`, { method: 'POST' }),
  connectClients: () => req<{ endpoint: string; clients: ClientView[] }>('/connect/clients'),
  connectTest: () => req<EndpointTest>('/connect/test', { method: 'POST' }),
  connectPreview: (client: string, transport: string) =>
    req<InstallPreview>('/connect/preview', { method: 'POST', body: JSON.stringify({ client, transport }) }),
  connectApply: (client: string, transport: string) =>
    req<InstallResult>('/connect/apply', { method: 'POST', body: JSON.stringify({ client, transport }) }),
};

/** Subscribe to the hub's live event stream; invokes cb on every event and auto-reconnects. */
export function useHubEvents(cb: (evt: any) => void): boolean {
  const [connected, setConnected] = useState(false);
  const cbRef = useRef(cb);
  cbRef.current = cb;
  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: any;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (e) => { try { cbRef.current(JSON.parse(e.data)); } catch {} };
      ws.onclose = () => { setConnected(false); if (!closed) retry = setTimeout(connect, 2000); };
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => { closed = true; clearTimeout(retry); ws?.close(); };
  }, []);
  return connected;
}

export function ago(ts: number | null): string {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
export const short = (id: string) => id.slice(0, 8);
export function copy(text: string): void { navigator.clipboard?.writeText(text); }
