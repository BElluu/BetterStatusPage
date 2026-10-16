import uiPreset from '@better-kit/ui/tailwind-preset'

/** @type {import('tailwindcss').Config} */
export default {
  presets: [uiPreset],
  // Relative to this file, not the working directory (see postcss.config.js).
  content: { relative: true, files: ['./index.html', './src/**/*.{ts,tsx}', '../../../packages/ui/src/**/*.{ts,tsx}'] },
}
