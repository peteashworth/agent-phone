// Env schema. Fails fast on boot; secrets only ever come from the environment (/etc/agent-phone.env on the droplet).
import { z } from 'zod'

const bool = z.enum(['true', 'false', '1', '0']).default('false').transform(v => v === 'true' || v === '1')
const boolOn = z.enum(['true', 'false', '1', '0']).default('true').transform(v => v === 'true' || v === '1')
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

  // ---- Milestone B safety layer
  // Local calling window at the destination, hours [start, end). Contacts without a tz must fit every continental US zone.
  CALL_HOURS_START: z.coerce.number().int().min(0).max(23).default(9),
  CALL_HOURS_END: z.coerce.number().int().min(1).max(24).default(20),
  // Spend caps. A live call reserves its worst case (MAX_CALL_SECONDS); ended calls count actual/estimated cost.
  SPEND_CAP_DAY_USD: z.coerce.number().min(0).default(5),
  SPEND_CAP_MONTH_USD: z.coerce.number().min(0).default(30),
  COST_PER_MIN_USD: z.coerce.number().min(0).default(0.08), // ElevenLabs ~$0.04-0.06 + Twilio $0.014, rounded up
  BILLING_TZ: z.string().default('America/Denver'),
  CONFIRM_TTL_MIN: z.coerce.number().int().min(1).max(120).default(15),
  // Never spoken on a call (output filter), comma-separated, case-insensitive. E.g. Pete's email and street address.
  PRIVATE_TERMS: list,
  // How long the close line gets to play before the server hangs up on a hard stop.
  HANGUP_DELAY_MS: z.coerce.number().int().min(0).max(15000).default(4500),

  // ---- Milestone C: answering machines, post-call log, recordings
  // Twilio async answering-machine detection on every live call. The brain's first reply waits for the verdict.
  AMD_ENABLED: boolOn,
  // Twilio MachineDetectionTimeout. No verdict by then (+1.5s) counts as a machine: we'd rather drop a person than
  // tell a voicemail why we called.
  AMD_TIMEOUT_S: z.coerce.number().int().min(3).max(30).default(6),
  // On a machine: hang up right away, or say VOICEMAIL_LINE (fixed; never the purpose) and then hang up.
  VOICEMAIL_ACTION: z.enum(['hangup', 'message']).default('hangup'),
  VOICEMAIL_LINE: z.string().max(200).default('Sorry I missed you. Goodbye.'),
  // Call audio is copied from ElevenLabs to DATA_DIR/recordings and deleted after this many days.
  SAVE_RECORDINGS: boolOn,
  RECORDING_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  // ElevenLabs credits -> USD (Starter: 185 credits = $0.037 on the Oct 8 call). Twilio AMD is $0.0075 per call.
  ELEVENLABS_USD_PER_CREDIT: z.coerce.number().min(0).default(0.0002),
  AMD_FEE_USD: z.coerce.number().min(0).default(0.0075),
  // Dashboard ping when a call changes (POST, bearer token), e.g. https://jasmine-api.ashworthhub.com/notify/calls
  DASHBOARD_NOTIFY_URL: z.url().optional(),
  DASHBOARD_NOTIFY_TOKEN: z.string().optional(),

  // ---- custom-LLM path (ElevenLabs -> {BASE_PATH}/llm/v1 -> brain)
  CUSTOM_LLM_SECRET: z.string().min(24).optional(),
  // canned = scripted test lines (no model). openai = any OpenAI-compatible chat/completions endpoint (Milestone D).
  BRAIN: z.enum(['canned', 'openai']).default('canned'),
  BRAIN_URL: z.url().optional(),
  BRAIN_API_KEY: z.string().optional(),
  BRAIN_MODEL: z.string().optional(),

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
  if (c.CALL_HOURS_END <= c.CALL_HOURS_START) throw new Error('CALL_HOURS_END must be after CALL_HOURS_START')
  if (c.BRAIN === 'openai' && (!c.BRAIN_URL || !c.BRAIN_MODEL)) throw new Error('BRAIN=openai needs BRAIN_URL and BRAIN_MODEL')
  return c
}
