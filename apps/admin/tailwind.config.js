/**
 * Colours are CSS variables (so branding and dark mode can swap them at runtime). Wrapping each in
 * color-mix with Tailwind's <alpha-value> placeholder keeps opacity modifiers such as `bg-primary/10`
 * working; without a modifier the mix is 100% and renders the variable unchanged.
 */
const token = (name) => `color-mix(in srgb, var(${name}) calc(<alpha-value> * 100%), transparent)`

/** @type {import('tailwindcss').Config} */
export default {
  // Relative to this file, not the working directory (see postcss.config.js).
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}'] },
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Branding aliases (runtime overrideable)
        primary: token('--color-primary'),
        accent: token('--color-accent'),
        // M3 surface tokens (CSS-var backed → respond to dark mode)
        surface: token('--m3-surface'),
        'surface-dim': token('--m3-surface-dim'),
        'surface-bright': token('--m3-surface-bright'),
        'surface-container-lowest': token('--m3-surface-container-lowest'),
        'surface-container-low': token('--m3-surface-container-low'),
        'surface-container': token('--m3-surface-container'),
        'surface-container-high': token('--m3-surface-container-high'),
        'surface-container-highest': token('--m3-surface-container-highest'),
        // M3 on-surface tokens
        'on-surface': token('--m3-on-surface'),
        'on-surface-variant': token('--m3-on-surface-variant'),
        // M3 misc
        secondary: token('--m3-secondary'),
        outline: token('--m3-outline'),
        'outline-variant': token('--m3-outline-variant'),
        'on-primary': token('--m3-on-primary'),
        'on-primary-container': token('--m3-on-primary-container'),
        'primary-fixed': token('--m3-primary-fixed'),
        'primary-container': token('--m3-primary-container'),
        'surface-tint': token('--m3-surface-tint'),
        'secondary-container': token('--m3-secondary-container'),
        'on-secondary-container': token('--m3-on-secondary-container'),
        'secondary-fixed': token('--m3-secondary-fixed'),
        error: token('--m3-error'),
        'error-container': token('--m3-error-container'),
        'on-error-container': token('--m3-on-error-container'),
        // Status colors
        'status-up': token('--m3-up'),
        'status-down': token('--m3-down'),
        'status-degraded': token('--m3-degraded'),
        'status-partial': token('--m3-partial'),
      },
      fontFamily: {
        headline: ['Manrope', 'system-ui', 'sans-serif'],
        display: ['Manrope', 'system-ui', 'sans-serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
        // Small uppercase eyebrow labels (Dashboard, Setup); same face as body text.
        label: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      animation: {
        'fade-up': 'fadeUp 0.45s ease forwards',
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
