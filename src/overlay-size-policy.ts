// The pinned overlay has one minimum size. electron/main.ts clamps the native
// window to the same numbers (tests/overlay-size-policy.test.mjs keeps them in
// step), so dragging the resize handle never asks for a size the window
// refuses, and the compact layout below 360 px stays reachable.

export interface OverlaySize {
    width: number;
    height: number;
}

export const MIN_OVERLAY_SIZE: Readonly<OverlaySize> = Object.freeze({ width: 280, height: 380 });

/** Keeps a dragged overlay size at or above the minimum. */
export function clampOverlaySize(width: number, height: number): OverlaySize {
    return {
        width: Math.max(MIN_OVERLAY_SIZE.width, width),
        height: Math.max(MIN_OVERLAY_SIZE.height, height)
    };
}
