import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

// Shared helpers for tests that inspect production source instead of importing
// Electron entry points. Working trees may be checked out with CRLF, so every
// read is normalized to LF before anchors or regexes are applied.
const repositoryRoot = path.resolve(import.meta.dirname, '..', '..');

export function readSource(relPath) {
  return fs.readFileSync(path.join(repositoryRoot, relPath), 'utf8').replace(/\r\n/g, '\n');
}

function isFunctionInitializer(node) {
  return node !== undefined && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));
}

// Finds a module-level `function name()` (the implementation, not overload
// signatures) or `const name = (async) () => ...` / `const name = function`.
function findTopLevelFunction(sourceFile, name) {
  return sourceFile.statements.find(statement => {
    if (ts.isFunctionDeclaration(statement)) {
      return statement.name?.text === name && statement.body !== undefined;
    }
    return ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration =>
        ts.isIdentifier(declaration.name)
        && declaration.name.text === name
        && isFunctionInitializer(declaration.initializer));
  });
}

// Returns the source text of the named module-level functions, in the requested
// order and joined by newlines, ready for ts.transpileModule.
export function extractFunctions(relPath, names) {
  const sourceFile = ts.createSourceFile(relPath, readSource(relPath), ts.ScriptTarget.Latest, true);
  const statements = [];
  for (const name of names) {
    const statement = findTopLevelFunction(sourceFile, name);
    assert.ok(statement, `Missing function ${name} in ${relPath}`);
    if (!statements.includes(statement)) statements.push(statement);
  }
  return statements.map(statement => statement.getText(sourceFile)).join('\n');
}

// Returns text from the start marker (inclusive) to the first end marker after
// it (exclusive).
export function sliceBetween(text, start, end) {
  const begin = text.indexOf(start);
  assert.notEqual(begin, -1, `Missing start marker: ${start}`);
  const finish = text.indexOf(end, begin + start.length);
  assert.notEqual(finish, -1, `Missing end marker after ${start}: ${end}`);
  return text.slice(begin, finish);
}
