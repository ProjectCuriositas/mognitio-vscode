import * as path from 'node:path';
export function compatibleVersion(version: unknown, expectedDevelopment?: string): boolean {
  if (typeof version !== 'string') return false;
  if (expectedDevelopment !== undefined) return version === expectedDevelopment;
  return /^0\.15\.(0|[1-9][0-9]*)$/.test(version) || version === '1.0.0';
}
export function contains(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
export function conflicts(roots: readonly string[]): Set<number> {
  const rejected = new Set<number>();
  for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
    if (contains(roots[i], roots[j]) || contains(roots[j], roots[i])) {
      rejected.add(i); rejected.add(j);
    }
  }
  return rejected;
}
export function compatibleCapabilities(c: any): boolean {
  const sync = c?.textDocumentSync;
  const semantic = c?.semanticTokensProvider;
  return c?.positionEncoding === 'utf-16' && sync?.openClose === true && sync?.change === 1
    && semantic?.full === true && Array.isArray(semantic?.legend?.tokenTypes)
    && Array.isArray(semantic?.legend?.tokenModifiers);
}
