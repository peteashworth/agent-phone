import { parsePhoneNumberFromString } from 'libphonenumber-js/max'

/** Normalizes user input to E.164 (US default). Returns null if it isn't a valid, dialable number. */
export function toE164(input: string): string | null {
  const p = parsePhoneNumberFromString(input.trim(), 'US')
  return p?.isValid() ? p.number : null
}
