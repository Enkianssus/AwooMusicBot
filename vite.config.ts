import { defineConfig } from 'vite'
import path from 'node:path'
import electronSimple from 'vite-plugin-electron/simple'
// 兼容不同 Node/打包环境下的 default 嵌套
const electron = (electronSimple as any).default ?? electronSimple
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
      },
    }),
  ],
})
