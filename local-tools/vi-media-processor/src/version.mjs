import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageMetadata = require('../package.json');

// This is recorded with every run so a project-owned configuration can state
// its minimum compatible processor without maintaining a duplicate version.
export const PROCESSOR_VERSION = packageMetadata.version;
