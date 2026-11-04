import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { b2Exact as exact, b2Need as need } from '../job-runtime/d1-b2-contracts.ts';
import { checkedRelativeFile, projectRootIdentity } from '../project-model/init-receipt.ts';
import { nativeFileIdentity, scopeContains } from './d1-b2-source.ts';

/** A transient index of raw FileChange keys, never a rewritten source or grant. */
export function mapB2PatchPaths(root: string, changes: unknown,
  scope: { allowed_paths: string[]; forbidden_paths: string[] }): Map<string, string> {
  projectRootIdentity(root);
  need(!!changes && typeof changes === 'object' && !Array.isArray(changes), 'PATCH_SHAPE');
  exact(changes, Object.keys(changes));
  const paths = new Map<string, string>(), aliases = new Set<string>();
  for (const raw of Object.keys(changes)) {
    let path = raw;
    if (/^[A-Za-z]:\\/.test(raw)) {
      // Only the observed Windows absolute backslash form is added. Check the
      // exact canonical root and segment grammar before any path resolution.
      need(process.platform === 'win32' && /^[A-Za-z]:\\/.test(root) && !raw.includes('/') &&
        raw.startsWith(root + '\\'), 'PATCH_CROSS_ROOT');
      path = raw.slice(root.length + 1).replaceAll('\\', '/');
    }
    checkedRelativeFile(path);
    need(scopeContains(scope.allowed_paths, path) && !scopeContains(scope.forbidden_paths, path), 'PATCH_SCOPE');
    // Case folding is only a collision detector, never a path or scope grant.
    const alias = process.platform === 'win32' ? path.toLowerCase() : path;
    need(!aliases.has(alias), 'PATCH_PATH_ALIAS'); aliases.add(alias);
    let parent = root, missing = false;
    const segments = path.split('/');
    for (let index = 0; index < segments.length; index++) {
      const segment = segments[index]!, physical = join(parent, segment);
      if (!missing) {
        const names = readdirSync(parent);
        if (process.platform === 'win32') need(!names.some(name =>
          name !== segment && name.toLowerCase() === segment.toLowerCase()), 'PATCH_PATH_ALIAS');
        const stat = lstatSync(physical, { throwIfNoEntry: false });
        if (stat) {
          need(names.includes(segment), 'PATCH_PATH_ALIAS');
          nativeFileIdentity(physical);
          need(index === segments.length - 1 ? stat.isFile() : stat.isDirectory(), 'PATCH_PATH_KIND');
        } else missing = true;
      }
      parent = physical;
    }
    // Missing add/delete leaves are valid; the existing ancestor identities
    // have still been checked. Existing links and hard links are never accepted.
    paths.set(path, raw);
  }
  return paths;
}
