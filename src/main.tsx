import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'

const originalFetch = window.fetch;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // 拦截所有根路径开头的 API 请求，强行重定向到我们的大脑 5555 端口
    if (typeof input === 'string' && input.startsWith('/')) {
        input = `http://127.0.0.1:5555${input}`;
    }
    return originalFetch(input, init);
};

export function useAppSync(fetchDataFunction: () => void) {
    import('react').then(({ useEffect }) => {
        // 2. 多窗口实时对齐机制
        // 每隔 1 秒主动去后端拉一次数据。因为所有客户端都拉的同一个 5555 后端，
        // 你在浏览器删歌，Electron 里的队列和 OBS 里的队列瞬间就一致了！
        useEffect(() => {
            fetchDataFunction(); // 执行第一次获取

            const timer = setInterval(() => {
                fetchDataFunction();
            }, 1000); // 1秒一次的心跳轮询

            return () => clearInterval(timer);
        }, [fetchDataFunction]);
    });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

// Use contextBridge
window.ipcRenderer.on('main-process-message', (_event, message) => {
  console.log(message)
})
