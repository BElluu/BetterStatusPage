import { URL, fileURLToPath } from 'node:url'

export default {
  plugins: {
    // Explicit path: Tailwind would look in the working directory, which is the repo root when Vite is started
    // from there with `vite apps/admin` (as the e2e suite does).
    tailwindcss: { config: fileURLToPath(new URL('./tailwind.config.js', import.meta.url)) },
    autoprefixer: {},
  },
}
