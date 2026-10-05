import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from '/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript/lib/typescript.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function resolve(specifier, context, defaultResolve) {
  if (specifier === '@miki/config') return { url: pathToFileURL(path.join(root, 'scripts', 'p0-config-stub.mjs')).href, shortCircuit: true };
  if (specifier.startsWith('@miki/')) return defaultResolve(specifier, context, defaultResolve);
  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    const parent = context.parentURL ? fileURLToPath(context.parentURL) : root;
    const base = specifier.startsWith('.') ? path.resolve(path.dirname(parent), specifier) : specifier;
    const candidates = [base, base.replace(/\.js$/, '.ts'), path.join(base, 'index.ts')];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return defaultResolve(specifier, context, defaultResolve);
}
export async function load(url, context, defaultLoad) {
  if (!url.endsWith('.ts')) return defaultLoad(url, context, defaultLoad);
  const source = fs.readFileSync(fileURLToPath(url), 'utf8');
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, sourceMap: false, importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove, verbatimModuleSyntax: false }, fileName: fileURLToPath(url) });
  return { format: 'module', source: result.outputText, shortCircuit: true };
}
