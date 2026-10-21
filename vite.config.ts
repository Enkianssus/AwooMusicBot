import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import electronSimple from 'vite-plugin-electron/simple'
// 兼容不同 Node/打包环境下的 default 嵌套
const electron = (electronSimple as any).default ?? electronSimple
import react from '@vitejs/plugin-react'

const nodeRequire = createRequire(import.meta.url)

// OBS 展示页只需要 hls.js 的一个浏览器构建文件；随渲染进程产物输出到
// dist/overlay-vendor，避免把整个 hls.js 包放进 app.asar。
function overlayVendorAssets(): Plugin {
  const rendererOutDir = path.join(__dirname, 'dist')
  let rendererBuild = false
  return {
    name: 'awoo-overlay-vendor-assets',
    apply: 'build',
    configResolved(config) {
      // main/preload 子构建输出到 dist-electron，不能收到这份副本。
      rendererBuild = path.relative(rendererOutDir, path.resolve(config.root, config.build.outDir)) === ''
    },
    generateBundle() {
      if (!rendererBuild) return
      this.emitFile({
        type: 'asset',
        fileName: 'overlay-vendor/hls.min.js',
        source: fs.readFileSync(nodeRequire.resolve('hls.js/dist/hls.min.js')),
      })
    },
  }
}

// 未安装的可选 peer 依赖会被 Vite 换成不抛错的 {}，ws 因此不会回退到纯 JS 实现（bufferUtil.mask 不存在）。
function rejectOptionalPeerDepStubs(): Plugin {
  return {
    name: 'awoo-reject-optional-peer-dep-stubs',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        const stubbed = output.code.includes('__viteOptionalPeerDep_')
          || Object.keys(output.modules).some(id => id.startsWith('__vite-optional-peer-dep'))
        if (stubbed) {
          this.error(`${output.fileName} 含有 Vite 的可选 peer 依赖空替身（__viteOptionalPeerDep_），请把 bufferutil、utf-8-validate 装为 devDependencies`)
        }
      }
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    overlayVendorAssets(),
    electron({
      main: {
        // Shortcut of `build.lib.entry`.
        entry: 'electron/main.ts',
        // 保留可读的函数名，用户提交的日志堆栈才能对应到源码。
        // 打包时 main 先于 preload 顺序构建，先清空 dist-electron，
        // 避免旧的按需加载分块（带哈希文件名）残留并被打进安装包。
        vite: {
          plugins: [rejectOptionalPeerDepStubs()],
          build: { minify: false, emptyOutDir: command === 'build' },
        },
      },
      preload: {
        // Shortcut of `build.rollupOptions.input`.
        // Preload scripts may contain Web assets, so use the `build.rollupOptions.input` instead `build.lib.entry`.
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: { build: { minify: false } },
      },
    }),
  ],
}))
