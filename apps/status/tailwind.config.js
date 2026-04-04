/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Branding aliases (runtime overrideable)
        primary: 'var(--color-primary)',
        accent: 'var(--color-accent)',
        // M3 surface tokens (CSS-var backed → respond to dark mode)
        surface: 'var(--m3-surface)',
        'surface-dim': 'var(--m3-surface-dim)',
        'surface-bright': 'var(--m3-surface-bright)',
        'surface-container-lowest': 'var(--m3-surface-container-lowest)',
        'surface-container-low': 'var(--m3-surface-container-low)',
        'surface-container': 'var(--m3-surface-container)',
        'surface-container-high': 'var(--m3-surface-container-high)',
        'surface-container-highest': 'var(--m3-surface-container-highest)',
        // M3 on-surface tokens
        'on-surface': 'var(--m3-on-surface)',
        'on-surface-variant': 'var(--m3-on-surface-variant)',
        // M3 misc
        secondary: 'var(--m3-secondary)',
        outline: 'var(--m3-outline)',
        'outline-variant': 'var(--m3-outline-variant)',
        'on-primary': 'var(--m3-on-primary)',
        'on-primary-container': 'var(--m3-on-primary-container)',
        'primary-fixed': 'var(--m3-primary-fixed)',
        'primary-container': 'var(--m3-primary-container)',
        'surface-tint': 'var(--m3-surface-tint)',
        'secondary-container': 'var(--m3-secondary-container)',
        'on-secondary-container': 'var(--m3-on-secondary-container)',
        error: 'var(--m3-error)',
        'error-container': 'var(--m3-error-container)',
        'on-error-container': 'var(--m3-on-error-container)',
        // Status colors
        'status-up': 'var(--m3-up)',
        'status-down': 'var(--m3-down)',
        'status-degraded': 'var(--m3-degraded)',
      },
      fontFamily: {
        headline: ['Manrope', 'system-ui', 'sans-serif'],
        display: ['Manrope', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      animation: {
        'fade-up': 'fadeUp 0.45s ease forwards',
        'pulse-slow': 'pulse 2.4s ease-in-out infinite',
      },
      keyframes: {
        fadeUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      borderRadius: {
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
    },
  },
  plugins: [],
}
