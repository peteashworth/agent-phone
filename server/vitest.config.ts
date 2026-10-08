import { defineConfig } from 'vitest/config'

// Keep loopback requests (MCP e2e test) off any HTTP proxy in the environment.
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',')
process.env.no_proxy = process.env.NO_PROXY

export default defineConfig({ test: { include: ['test/**/*.test.ts'] } })
