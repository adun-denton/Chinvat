import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SAFE = /[^a-zA-Z0-9._-]/g;

export class ArtifactStore {
  readonly root: string;

  constructor(dataDir: string) {
    this.root = path.join(dataDir, 'artifacts');
    fs.mkdirSync(this.root, { recursive: true });
  }

  private jobDir(jobId: string): string {
    return path.join(this.root, jobId.replace(SAFE, '_'));
  }

  async save(jobId: string, name: string, content: string | Buffer): Promise<string> {
    const dir = this.jobDir(jobId);
    await fsp.mkdir(dir, { recursive: true });
    const safeName = name.replace(SAFE, '_') || 'artifact';
    const file = path.join(dir, safeName);
    await fsp.writeFile(file, content);
    return path.relative(this.root, file);
  }

  list(jobId: string): { name: string; size: number }[] {
    const dir = this.jobDir(jobId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((name) => ({
      name,
      size: fs.statSync(path.join(dir, name)).size,
    }));
  }

  /** Absolute path for serving; refuses traversal outside the store. */
  resolve(jobId: string, name: string): string | null {
    const file = path.resolve(this.jobDir(jobId), name);
    if (!file.startsWith(path.resolve(this.root) + path.sep)) return null;
    return fs.existsSync(file) ? file : null;
  }
}
