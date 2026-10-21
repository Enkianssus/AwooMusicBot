/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}", // 确保扫描到 React 组件
  ],
  theme: {
    extend: {
      // Entrance and highlight animations used by the control panel and the overlay.
      // The prefers-reduced-motion rules in admin-ui.css and overlay-polish.css turn them off.
      keyframes: {
        'slide-in': {
          from: { opacity: '0', transform: 'translateY(15px) scale(0.98)' },
          to: { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        'slide-in-right': {
          from: { opacity: '0', transform: 'translateX(10px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'fade-in': {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        // The toast stack is centred by its container, so the toast itself only drops in.
        toast: {
          from: { opacity: '0', transform: 'translateY(-20px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          to: { transform: 'translateX(100%)' },
        },
      },
      animation: {
        'slide-in': 'slide-in 0.3s ease-out',
        'slide-in-right': 'slide-in-right 0.25s ease-out',
        'fade-in': 'fade-in 0.2s ease-out',
        fadeIn: 'fade-in 0.2s ease-out',
        toast: 'toast 0.3s ease-out',
        shimmer: 'shimmer 2s infinite',
      },
    },
  },
  plugins: [],
}
