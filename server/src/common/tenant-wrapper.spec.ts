import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * tx.2 (#151): every public method that reads `currentRequestContext()` — directly, or
 * through a private method of its own class — opens its transaction through
 * `TenantService.runTx`. Since tx.4 (#153) there is no request-wide transaction, so a method
 * that skips it 500s — but only on the paths a test happens to reach, so it is a source scan,
 * like `tenant-door.spec.ts`.
 *
 * The one accepted shape is the wrapper tx.2 introduced, whole body:
 *
 *     name(args) { return this.tenants.runTx(() => this.nameIn(args)); }
 */
const WRAPPER =
  /^\{\s*return this\.tenants\.runTx\(\(\) =>\s*this\.(\w+)In\([^)]*\),?\s*\);\s*\}$/;

/** `Class.method` → why it may read the context without the wrapper. */
const UNWRAPPED_ALLOWED: Record<string, string> = {
  // It does open its own runTx — the reader `readTenantAndPinHash` runs only inside it — but the body is
  // not the whole-body wrapper, because argon2 has to run AFTER that transaction commits.
  // Wrapping the whole method would put the ~75 ms verify back inside a held connection.
  'VoidService.authorise':
    'tx.5 (#154): a short runTx reads pin_hash, then verifyPassword runs with no transaction',
};

/** Every non-private method that reaches `currentRequestContext()` without the wrapper. */
function unwrappedReaders(source: string, file = 'x.ts'): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const methods = node.members.filter(ts.isMethodDeclaration);
      const byName = new Map(methods.map((m) => [m.name.getText(sf), m]));
      const isPrivate = (m: ts.MethodDeclaration) =>
        (m.modifiers ?? []).some(
          (x) =>
            x.kind === ts.SyntaxKind.PrivateKeyword ||
            x.kind === ts.SyntaxKind.ProtectedKeyword,
        ) || ts.isPrivateIdentifier(m.name);
      const reaches = (m: ts.MethodDeclaration, seen: Set<string>): boolean => {
        const name = m.name.getText(sf);
        if (seen.has(name)) return false;
        seen.add(name);
        const body = m.body?.getText(sf) ?? '';
        if (/\bcurrentRequestContext\s*\(/.test(body)) return true;
        return [...body.matchAll(/this\.(\w+)\s*\(/g)].some(([, callee]) => {
          const target = byName.get(callee);
          return (
            target !== undefined && isPrivate(target) && reaches(target, seen)
          );
        });
      };
      for (const m of methods) {
        if (isPrivate(m) || !reaches(m, new Set())) continue;
        const name = m.name.getText(sf);
        const wrapped = WRAPPER.exec(m.body?.getText(sf) ?? '');
        if (wrapped?.[1] === name) continue;
        found.push(`${node.name.text}.${name}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/**
 * `void.service.ts` with `authorise`'s one sanctioned call — `this.tenants.runTx(() =>
 * this.readTenantAndPinHash(actor))` — replaced by a value. Throws unless it occurs exactly once.
 */
function authoriseStripped(source: string): string {
  const sanctioned =
    /this\.tenants\.runTx\(\(\) =>\s*this\.readTenantAndPinHash\(actor\),?\s*\)/g;
  const hits = source.match(sanctioned) ?? [];
  if (hits.length !== 1) {
    throw new Error(`expected one sanctioned runTx call, found ${hits.length}`);
  }
  return source.replace(sanctioned, 'Promise.resolve(null as never)');
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('every request-context reader opens its own runTx (tx.2 #151)', () => {
  it('recognises a direct reader, a reader through a private helper, and the wrapper', () => {
    const src = `
      class S {
        async direct() { const { manager } = currentRequestContext(); }
        async viaHelper() { return this.helper(); }
        private async helper() { return currentRequestContext().manager; }
        wrapped(a: string) {
          return this.tenants.runTx(() => this.wrappedIn(a));
        }
        private async wrappedIn(a: string) { return currentRequestContext(); }
        async noContext() { return 1; }
        misnamed() { return this.tenants.runTx(() => this.otherIn()); }
        private async otherIn() { return currentRequestContext(); }
        partial() {
          const t = currentRequestContext().tenantId;
          return this.tenants.runTx(() => this.partialIn());
        }
        private async partialIn() { return currentRequestContext(); }
      }`;
    expect(unwrappedReaders(src)).toEqual([
      'S.direct',
      'S.viaHelper',
      'S.misnamed',
      'S.partial',
    ]);
  });

  it('finds no unwrapped reader outside the allowlist, and no stale allowlist entry', () => {
    const found = tsFiles(SRC).flatMap((path) => {
      const source = readFileSync(path, 'utf8');
      if (!source.includes('currentRequestContext')) return [];
      const file = relative(SRC, path).split(sep).join('/');
      return unwrappedReaders(source, file);
    });
    expect(found.filter((m) => !(m in UNWRAPPED_ALLOWED))).toEqual([]);
    expect(
      Object.keys(UNWRAPPED_ALLOWED).filter((m) => !found.includes(m)),
    ).toEqual([]);
  });

  it('VoidService.authorise reaches the context only through its own runTx', () => {
    // The allowlist entry above exempts the method from the whole-body shape, not from
    // opening a transaction. Take its one sanctioned call out of the source and scan what is
    // left: any other way `authorise` reaches the context — a direct call, or another private
    // reader — is still found.
    const source = readFileSync(join(SRC, 'sales/void.service.ts'), 'utf8');
    expect(unwrappedReaders(authoriseStripped(source))).toEqual([]);
  });

  it('the authorise check goes red on a reader planted outside its runTx', () => {
    const source = readFileSync(join(SRC, 'sales/void.service.ts'), 'utf8');
    const planted = source.replace(
      /(async authorise\([^)]*\)[^{]*\{)/,
      '$1\n    await this.readTenantAndPinHash(actor);',
    );
    expect(planted).not.toBe(source);
    expect(unwrappedReaders(authoriseStripped(planted))).toEqual([
      'VoidService.authorise',
    ]);
  });
});
