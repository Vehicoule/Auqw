// Loader for the ui-web test entry: node's strip-types handles .ts but
// refuses .tsx, so this resolves .tsx imports and transpiles them with
// the repo's own typescript (devDep) into react-jsx runtime calls.
// Components never run under a bundler in tests — only this loader
// knows .tsx exists.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** @type {import('typescript').TranspileOptions['compilerOptions']} */
const compilerOptions = {
  module: ts.ModuleKind.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ES2022,
};

export function resolve(specifier, context, next) {
  if (specifier.endsWith('.tsx') && context.parentURL !== undefined) {
    return {
      url: new URL(specifier, context.parentURL).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}

export function load(url, context, next) {
  if (!url.endsWith('.tsx')) {
    return next(url, context);
  }
  const { outputText } = ts.transpileModule(
    readFileSync(fileURLToPath(url), 'utf8'),
    { compilerOptions, fileName: fileURLToPath(url) },
  );
  return { format: 'module', source: outputText, shortCircuit: true };
}
