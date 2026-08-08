/// <reference types="vite/client" />

interface Window {
  electronAPI?: {
    openAdmin: (tab?: string) => void;
    openExternal: (url: string) => Promise<void>;
    claimWelcomeHint: (legacyHintWasShown: boolean) => Promise<boolean>;
    onAdminNavigate: (callback: (tab: string) => void) => () => void;
    closeWindow: () => void;
    minimizeWindow: () => void;
    resizeOverlay: (width: number, height: number) => void;
  };
}
