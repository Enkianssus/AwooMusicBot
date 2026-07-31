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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
