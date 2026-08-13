const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function parseSemver(value) {
  if (typeof value !== 'string') throw new Error('Version must be a semantic version string');
  const match = SEMVER_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid semantic version: ${value}`);
  const prerelease = match[4] ? match[4].split('.') : [];
  for (const identifier of prerelease) {
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) {
      throw new Error(`Invalid semantic version: ${value}`);
    }
  }
  return {
    raw: value,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

export function compareSemver(leftValue, rightValue) {
  const left = typeof leftValue === 'string' ? parseSemver(leftValue) : leftValue;
  const right = typeof rightValue === 'string' ? parseSemver(rightValue) : rightValue;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  if (!left.prerelease.length && !right.prerelease.length) return 0;
  if (!left.prerelease.length) return 1;
  if (!right.prerelease.length) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric) return -1;
    if (bNumeric) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

export function assertMinimumVersion(currentVersion, minimumVersion) {
  const current = parseSemver(currentVersion);
  const minimum = parseSemver(minimumVersion);
  if (compareSemver(current, minimum) < 0) {
    throw new Error(`Project config requires processor >= ${minimum.raw}; current processor is ${current.raw}`);
  }
}
