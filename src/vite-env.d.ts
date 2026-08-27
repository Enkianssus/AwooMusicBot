/// <reference types="vite/client" />

interface Window {
  electronAPI?: {
    internalApiOrigin: string;
    getOverlayAlwaysOnTop?: () => boolean;
    setOverlayAlwaysOnTop?: (enabled: boolean) => boolean;
    openAdmin: (tab?: string) => void;
    openExternal: (url: string) => Promise<void>;
    claimWelcomeHint: (legacyHintWasShown: boolean) => Promise<boolean>;
    onAdminNavigate: (callback: (tab: string) => void) => () => void;
    closeWindow: () => void;
    minimizeWindow: () => void;
    resizeOverlay: (width: number, height: number) => void;
  };
}
