import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { extractFunctions, readSource, sliceBetween } from './helpers/source.mjs';

// electron-builder copies every production dependency into app.asar, while Vite
// already bundles the main process. Only runtime-loaded packages belong there.
const repositoryRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(readSource('package.json'));

test('bundled-only and unloadable native packages stay out of production dependencies', () => {
  for (const name of ['cheerio', 'bufferutil', 'utf-8-validate']) {
    assert.equal(Object.hasOwn(packageJson.dependencies, name), false, `${name} must not be copied into app.asar`);
  }
  assert.ok(Object.hasOwn(packageJson.dependencies, 'velopack'), 'velopack is required from node_modules at runtime');
});

test('ws optional peers stay installed for bundling but out of app.asar', () => {
  // Without them Vite replaces ws's optional require() with a non-throwing {}, so ws
  // never falls back to its JS masking and every client frame of 48+ bytes throws.
  const lock = JSON.parse(readSource('package-lock.json'));
  for (const name of ['bufferutil', 'utf-8-validate']) {
    assert.ok(Object.hasOwn(packageJson.devDependencies, name), `${name} must stay a devDependency`);
    assert.equal(Object.hasOwn(packageJson.dependencies, name), false, `${name} must not be copied into app.asar`);
    assert.equal(lock.packages[''].devDependencies[name], packageJson.devDependencies[name]);
    assert.equal(Object.hasOwn(lock.packages[''].dependencies, name), false);
    const installed = lock.packages[`node_modules/${name}`];
    assert.ok(installed?.dev === true || installed?.devOptional === true, `${name} is locked as a build-time package`);
  }
});

test('the main build fails when Vite stubs a missing optional peer dependency', () => {
  const viteConfig = readSource('vite.config.ts');
  assert.match(
    sliceBetween(viteConfig, 'main: {', 'preload: {'),
    /plugins: \[rejectOptionalPeerDepStubs\(\)\]/,
    'the guard runs on the main sub-build, which bundles ws'
  );
  const context = vm.createContext({});
  vm.runInContext(ts.transpileModule(extractFunctions('vite.config.ts', ['rejectOptionalPeerDepStubs']), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText, context);
  const guard = context.rejectOptionalPeerDepStubs();
  const generate = bundle => guard.generateBundle.call(
    { error(message) { throw new Error(message); } },
    {},
    bundle
  );
  const chunk = (fileName, code, moduleIds = []) => ({
    type: 'chunk',
    fileName,
    code,
    modules: Object.fromEntries(moduleIds.map(id => [id, {}]))
  });

  generate({
    'main-ok.js': chunk('main-ok.js', 'const bufferUtil = fallback;', ['E:/app/node_modules/bufferutil/fallback.js']),
    'notes.txt': { type: 'asset', fileName: 'notes.txt', source: '__viteOptionalPeerDep_ in an asset is not code' }
  });
  // The stub Vite 5 emits for an uninstalled optional peer, found by name or, once minified, by module id.
  assert.throws(
    () => generate({ 'main-a.js': chunk('main-a.js', 'const __viteOptionalPeerDep_bufferutil_ws = {};') }),
    /main-a\.js.*__viteOptionalPeerDep_/
  );
  assert.throws(
    () => generate({ 'main-b.js': chunk('main-b.js', 'const a = {};', ['__vite-optional-peer-dep:utf-8-validate:ws']) }),
    /main-b\.js/
  );
});

test('the package contains the app entries and only the built-in overlay', () => {
  const files = packageJson.build.files;
  for (const entry of ['dist', 'dist-electron', 'examples/obs-overlay']) {
    assert.ok(files.includes(entry), `build.files must include ${entry}`);
  }
  assert.equal(files.some(entry => entry.startsWith('examples/obs-overlay-white')), false);

  const velopackExclusions = files.filter(entry => entry.startsWith('!node_modules/velopack/'));
  assert.notEqual(velopackExclusions.length, 0, 'natives the Windows x64 app never loads are excluded');
  for (const exclusion of velopackExclusions) {
    // Name platforms explicitly: a wildcard could also drop the natives the app loads.
    assert.doesNotMatch(exclusion, /\*|win_x64|win_x86/);
  }
});

test('package.json "build" is the only electron-builder configuration', () => {
  assert.equal(fs.existsSync(path.join(repositoryRoot, 'electron-builder.json5')), false);
});

test('the renderer build vendors the OBS overlay hls.js file', () => {
  const viteConfig = readSource('vite.config.ts');
  assert.match(viteConfig, /'hls\.js\/dist\/hls\.min\.js'/);
  assert.match(viteConfig, /overlay-vendor/);
});

test('hls.js is a build-time dependency only', () => {
  // The renderer bundles it and the OBS overlay serves the vendored copy from
  // dist/overlay-vendor; the 30 MB package must not be copied into app.asar.
  assert.equal(Object.hasOwn(packageJson.dependencies, 'hls.js'), false);
  assert.ok(Object.hasOwn(packageJson.devDependencies, 'hls.js'));
  const lock = JSON.parse(readSource('package-lock.json'));
  assert.equal(Object.hasOwn(lock.packages[''].dependencies, 'hls.js'), false);
  assert.equal(lock.packages['node_modules/hls.js'].dev, true);
});
