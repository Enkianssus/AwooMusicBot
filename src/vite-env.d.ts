/// <reference types="vite/client" />

interface Window {
  electronAPI?: {
    openAdmin: () => void;
    closeWindow: () => void;
    minimizeWindow: () => void;
    resizeOverlay: (width: number, height: number) => void;
  };
}
