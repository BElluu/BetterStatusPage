import { defineConfig } from 'astro/config'
import { unified } from '@astrojs/markdown-remark'
import remarkDocs from './src/remark-docs.mjs'

export default defineConfig({
  site: 'https://docs.betterstatuspage.dev',
  trailingSlash: 'always',
  markdown: {
    processor: unified({ remarkPlugins: [remarkDocs] }),
    shikiConfig: {
      // Both themes are emitted as CSS variables; global.css picks one from the `dark` class.
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    },
  },
})
