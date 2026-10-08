// Env schema. Fails fast on boot; secrets only ever come from the environment (/etc/agent-phone.env on the droplet).
import { z } from 'zod'

const bool = z.enum(['true', 'false', '1', '0']).default('false').transform(v => v === 'true' || v === '1')
const list = z.string().default('').transform(v => v.split(',').map(s => s.trim()).filter(Boolean))

const schema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(3600),
  BASE_PATH: z.string().default('/phone'),
  // Public URL of BASE_PATH as Twilio/ElevenLabs see it; used to build webhook URLs and to verify Twilio signatures.
  PUBLIC_BASE_URL: z.url().default('https://jasmine.ashworthhub.com/phone'),
  DATA_DIR: z.string().default('./data'),

  // Master switch. false = every place_call is a dry run, whatever the caller asks for.
  DIALING_ENABLED: bool,
  // Destination guard (standing rule: Pete only until hard stops are built + signed off). "*" lifts it.
  ALLOWED_DESTINATIONS: list.default(['+14358403707']),
  MAX_CALL_SECONDS: z.coerce.number().int().min(30).max(600).default(300),

  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_API_KEY_SID: z.string().optional(),
  TWILIO_API_KEY_SECRET: z.string().optional(),
  // Either one authenticates Twilio webhooks. Auth token = real signature check (preferred).
  TWILIO_AUTH_TOKEN: z.string().optional(),
  WEBHOOK_TOKEN: z.string().min(24).optional(),

  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_AGENT_ID: z.string().optional(),

  TWILIO_API_BASE: z.url().default('https://api.twilio.com'),
  ELEVENLABS_API_BASE: z.url().default('https://api.elevenlabs.io'),
})

export type Config = z.infer<typeof schema>

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // Blank lines in /etc/agent-phone.env (KEY=) mean "not set", not "empty string".
  const parsed = schema.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== '')))
  if (!parsed.success) throw new Error('Invalid config:\n' + z.prettifyError(parsed.error))
  const c = parsed.data
  c.BASE_PATH = '/' + c.BASE_PATH.replace(/^\/+|\/+$/g, '')
  c.PUBLIC_BASE_URL = c.PUBLIC_BASE_URL.replace(/\/+$/, '')
  if (c.DIALING_ENABLED) {
    const missing = (['TWILIO_ACCOUNT_SID', 'TWILIO_API_KEY_SID', 'TWILIO_API_KEY_SECRET', 'ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID'] as const)
      .filter(k => !c[k])
    if (!c.TWILIO_AUTH_TOKEN && !c.WEBHOOK_TOKEN) missing.push('TWILIO_AUTH_TOKEN or WEBHOOK_TOKEN' as never)
    if (missing.length) throw new Error(`DIALING_ENABLED=true but missing: ${missing.join(', ')}`)
  }
  return c
}
