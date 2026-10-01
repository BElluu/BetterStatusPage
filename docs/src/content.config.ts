import { defineCollection } from 'astro:content'
import { glob } from 'astro/loaders'
import { z } from 'astro/zod'

// The guides live at the root of docs/, next to this site, so they read the same on GitHub.
// Front matter is optional: the title falls back to the first `# heading` (see src/nav.ts).
const guides = defineCollection({
  loader: glob({
    base: '.',
    pattern: ['*.md', '!README.md', '!publishing-ghcr.md'],
  }),
  schema: z.object({
    title: z.string().optional(),
    description: z.string().optional(),
  }),
})

export const collections = { guides }
