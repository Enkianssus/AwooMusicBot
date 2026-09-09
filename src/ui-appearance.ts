import { useCallback, useEffect, useState } from 'react';

export type ColorMode = 'light' | 'dark';

const COLOR_MODE_KEY = 'awoo-color-mode-v1';
const COLOR_MODE_EVENT = 'awoo-color-mode-change';
const DEFAULT_COLOR_MODE: ColorMode = 'dark';

function isColorMode(value: unknown): value is ColorMode {
    return value === 'light' || value === 'dark';
}

function readColorMode(): ColorMode {
    try {
        const saved = window.localStorage.getItem(COLOR_MODE_KEY);
        return isColorMode(saved) ? saved : DEFAULT_COLOR_MODE;
    } catch {
        return DEFAULT_COLOR_MODE;
    }
}

export function useColorMode() {
    const [colorMode, setColorMode] = useState<ColorMode>(readColorMode);

    useEffect(() => {
        const onLocalChange = (event: Event) => {
            const next = (event as CustomEvent<unknown>).detail;
            if (isColorMode(next)) setColorMode(next);
        };
        const onStorageChange = (event: StorageEvent) => {
            if (event.key !== COLOR_MODE_KEY && event.key !== null) return;
            setColorMode(isColorMode(event.newValue) ? event.newValue : DEFAULT_COLOR_MODE);
        };

        window.addEventListener(COLOR_MODE_EVENT, onLocalChange);
        window.addEventListener('storage', onStorageChange);
        return () => {
            window.removeEventListener(COLOR_MODE_EVENT, onLocalChange);
            window.removeEventListener('storage', onStorageChange);
        };
    }, []);

    const toggleColorMode = useCallback(() => {
        const next: ColorMode = colorMode === 'light' ? 'dark' : 'light';
        setColorMode(next);
        try {
            window.localStorage.setItem(COLOR_MODE_KEY, next);
        } catch {
            // The appearance control still works when storage is unavailable.
        }
        window.dispatchEvent(new CustomEvent(COLOR_MODE_EVENT, { detail: next }));
    }, [colorMode]);

    return { colorMode, toggleColorMode };
}
