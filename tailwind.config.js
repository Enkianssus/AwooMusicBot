/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}", // 确保扫描到 React 组件
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}

