import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import { internalApiOrigin } from './internal-api'

const originalFetch = window.fetch;
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    // Electron 通过安全 preload 提供实际端口；浏览器捕捉页面则使用当前 origin。
    if (typeof input === 'string' && input.startsWith('/') && internalApiOrigin) {
        input = `${internalApiOrigin}${input}`;
    } else if (input instanceof URL && input.origin === window.location.origin && input.pathname.startsWith('/') && internalApiOrigin) {
        input = new URL(`${internalApiOrigin}${input.pathname}${input.search}${input.hash}`);
    }
    return originalFetch(input, init);
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
