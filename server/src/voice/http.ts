// Injectable fetch so tests can stub providers without touching the network.
export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export class ProviderError extends Error {
  provider: string
  status: number
  body: string
  constructor(provider: string, status: number, body: string) {
    super(`${provider} HTTP ${status}: ${body.slice(0, 300)}`)
    this.provider = provider; this.status = status; this.body = body
  }
}
