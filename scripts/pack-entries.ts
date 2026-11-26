type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * npm has emitted both an array and a package-name-keyed object from
 * `npm pack --json`. Normalize either shape to the files in the tarball.
 */
export function extractPackEntries(parsed: unknown): string[] {
  const packages = Array.isArray(parsed)
    ? parsed
    : isJsonObject(parsed)
      ? Object.values(parsed)
      : [];

  return packages.flatMap(pkg => {
    if (!isJsonObject(pkg) || !Array.isArray(pkg.files)) return [];
    return pkg.files.flatMap(file => {
      if (!isJsonObject(file) || typeof file.path !== 'string') return [];
      return [file.path];
    });
  });
}
