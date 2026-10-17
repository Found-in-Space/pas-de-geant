import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(join(root, 'dist'), { recursive: true });
const entry = join(root, 'dist/skykit-runtime.js');
const contract = ts.createSourceFile('skykit-runtime.d.ts', await readFile(join(root, 'src/skykit-runtime.d.ts'), 'utf8'),
  ts.ScriptTarget.Latest, true);
const printer = ts.createPrinter();
const exports = contract.statements.filter(ts.isExportDeclaration);
const contents = exports.filter(statement => !statement.isTypeOnly)
  .map(statement => printer.printNode(ts.EmitHint.Unspecified, statement, contract)).join('\n');
const result = await build({ stdin: { contents, resolveDir: root, sourcefile: 'skykit-runtime-entry.js' }, bundle: true, write: false,
  platform: 'browser', format: 'esm', target: 'es2022', treeShaking: true,
  external: ['three', '@found-in-space/spatial'], metafile: true,
  banner: { js: '// SkyKit lifecycle: generated from the exact registry version in package-lock.json. See NOTICE.txt.' } });
for (const output of Object.values(result.metafile.outputs)) {
  for (const [input, info] of Object.entries(output.inputs)) {
    assert.ok(!info.bytesInOutput || !/\/(?:star-trees|star-octree-provider|three-star-field|hr-diagram|meta-sidecar-provider)\//.test(input),
      `SkyKit runtime unexpectedly includes star code: ${input}`);
  }
}
await writeFile(entry, result.outputFiles[0].contents);

// Keep the public declarations just as independent as the runtime. Select the
// reachable upstream declarations rather than copying or maintaining a fork of
// SkyKit's lifecycle contract. Unknown unions are normalized before traversal
// (SkyKit's optional look-at input includes star types unioned with unknown).
const require = createRequire(import.meta.url);
const skykitRoot = dirname(dirname(require.resolve('@found-in-space/skykit')));
const sources = new Map();
for (const name of ['index', 'xr']) {
  const path = join(skykitRoot, `src/${name}.d.ts`);
  sources.set(name, ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true));
}
const declarations = new Map();
const imports = new Map();
for (const source of sources.values()) {
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        imports.set(clause.namedBindings.name.text, statement.moduleSpecifier.text);
      } else for (const specifier of clause?.namedBindings?.elements ?? []) {
        imports.set(specifier.name.text, statement.moduleSpecifier.text);
      }
    } else if (statement.name) declarations.set(statement.name.text, statement);
    else if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      declarations.set(declaration.name.text, statement);
    }
  }
}
const names = new Set(exports.flatMap(statement => statement.exportClause.elements.map(element => element.name.text)));
const emitted = new Map();
const external = new Set();
for (const name of names) {
  const statement = declarations.get(name);
  assert.ok(statement, `Missing SkyKit declaration: ${name}`);
  const transformed = ts.transform(statement, [context => {
    const visit = node => ts.isUnionTypeNode(node) && node.types.some(type => type.kind === ts.SyntaxKind.UnknownKeyword)
      ? ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)
      : ts.visitEachChild(node, visit, context);
    return node => ts.visitNode(node, visit);
  }]);
  const node = transformed.transformed[0];
  const visit = child => {
    if (ts.isIdentifier(child)) {
      if (declarations.has(child.text)) names.add(child.text);
      else if (imports.has(child.text)) external.add(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  emitted.set(statement, printer.printNode(ts.EmitHint.Unspecified, node, statement.getSourceFile()));
  transformed.dispose();
}
const header = ['// Generated from pinned SkyKit public declarations; do not edit.'];
for (const name of external) {
  const module = imports.get(name);
  assert.ok(['three', '@found-in-space/spatial'].includes(module), `Unexpected runtime type dependency: ${name} from ${module}`);
  header.push(name === 'THREE' ? `import type * as THREE from 'three';`
    : `import type { ${name} } from '${module}';`);
}
await writeFile(join(root, 'dist/skykit-runtime.d.ts'), [...header, ...emitted.values()].join('\n\n') + '\n');

// TypeScript can name the canonical upstream symbol in inferred return types,
// even when source imports it through our local contract. Redirect those type
// imports to the bundled declarations too; runtime-only isolation is not enough.
for (const path of await readdir(join(root, 'dist'), { recursive: true })) {
  if (!path.endsWith('.d.ts')) continue;
  const file = join(root, 'dist', path);
  const original = await readFile(file, 'utf8');
  let target = relative(dirname(file), entry).split(sep).join('/');
  if (!target.startsWith('.')) target = './' + target;
  const redirected = original.replace(/(["'])@found-in-space\/skykit\1/g, JSON.stringify(target));
  if (redirected === original) continue;
  // Rewritten token lengths invalidate the compiler's declaration map.
  await writeFile(file, redirected.replace(/\/\/# sourceMappingURL=.*(?:\r?\n)?$/, ''));
  await rm(file + '.map', { force: true });
}
