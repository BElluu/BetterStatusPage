// Every end-to-end run starts from an empty instance, so the setup wizard and all scenarios are
// deterministic no matter what a previous run left behind.
import { rmSync } from 'node:fs'

rmSync(process.env['DATA_DIR'] ?? './.e2e', { recursive: true, force: true })
