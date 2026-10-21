import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { MIN_OVERLAY_SIZE, clampOverlaySize } from '../src/overlay-size-policy.ts';

const root = path.resolve(import.meta.dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'electron', 'main.ts'), 'utf8');
const appSource = fs.readFileSync(path.join(root, 'src', 'App.tsx'), 'utf8');

/** The minimum the native window enforces when the overlay asks to be resized. */
function nativeMinimumOverlaySize() {
    const handlerStart = mainSource.search(/ipcMain\.on\(\s*['"]overlay-resize['"]/);
    assert.ok(handlerStart >= 0, 'electron/main.ts handles overlay-resize');
    const handler = mainSource.slice(handlerStart, handlerStart + 1500);
    assert.match(handler, /MIN_OVERLAY_SIZE\.width[\s\S]*MIN_OVERLAY_SIZE\.height/, 'overlay-resize clamps to MIN_OVERLAY_SIZE');

    // main.ts may import the shared constant instead of declaring its own copy.
    if (/import\s*\{[^}]*\bMIN_OVERLAY_SIZE\b[^}]*\}\s*from\s*['"][^'"]*overlay-size-policy(?:\.ts)?['"]/.test(mainSource)) {
        return { ...MIN_OVERLAY_SIZE };
    }
    const declaration = mainSource.match(/\bMIN_OVERLAY_SIZE\s*(?::[^=]+)?=\s*(?:Object\.freeze\(\s*)?\{\s*width:\s*(\d+)\s*,\s*height:\s*(\d+)\s*\}/);
    assert.ok(declaration, 'electron/main.ts declares MIN_OVERLAY_SIZE');
    return { width: Number(declaration[1]), height: Number(declaration[2]) };
}

test('the renderer minimum overlay size is the size main.ts clamps the window to', () => {
    assert.deepEqual({ ...MIN_OVERLAY_SIZE }, nativeMinimumOverlaySize());
    assert.deepEqual({ ...MIN_OVERLAY_SIZE }, { width: 280, height: 380 });
});

test('dragged sizes stop at the minimum and are otherwise kept', () => {
    assert.deepEqual(clampOverlaySize(100, 100), { width: 280, height: 380 });
    assert.deepEqual(clampOverlaySize(279, 600), { width: 280, height: 600 });
    assert.deepEqual(clampOverlaySize(420, 379), { width: 420, height: 380 });
    assert.deepEqual(clampOverlaySize(512, 640), { width: 512, height: 640 });
});

test('both overlay resize handles use the shared minimum', () => {
    assert.doesNotMatch(appSource, /Math\.max\((?:240|300|400),/);
    const electronHandle = appSource.slice(appSource.indexOf('const handleElectronResizeStart'), appSource.indexOf('let dragRenderX'));
    assert.match(electronHandle, /clampOverlaySize\(/);
    assert.match(electronHandle, /resizeOverlay\(size\.width, size\.height\)/);
    const browserHandle = appSource.slice(appSource.indexOf('const handleResizeStart'), appSource.indexOf('const handleElectronResizeStart'));
    assert.match(browserHandle, /clampOverlaySize\(/);
});
