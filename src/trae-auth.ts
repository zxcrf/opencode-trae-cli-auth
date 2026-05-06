export type TraeAuthOptions = {
  baseURL: string
  pat?: string
  rawApiKey?: string
  abortSignal?: AbortSignal
}

export type TraeAuthToken = {
  token: string
  authorization: string
}

let cachedPat: string | undefined
let cachedToken: string | undefined
let cachedExpireAt = 0

export async function resolveTraeAuthToken(options: TraeAuthOptions): Promise<TraeAuthToken> {
  if (options.rawApiKey) {
    const token = options.rawApiKey
    return {
      token,
      authorization: token.startsWith('Cloud-IDE-JWT ') ? token : `Cloud-IDE-JWT ${token}`,
    }
  }
  if (!options.pat) {
    throw new Error('Trae raw chat requires provider.trae.options.pat or traeRawApiKey')
  }
  const now = Date.now()
  if (cachedPat === options.pat && cachedToken && cachedExpireAt - now > 60_000) {
    return { token: cachedToken, authorization: `Cloud-IDE-JWT ${cachedToken}` }
  }

  const response = await fetch(`${stripTrailingSlash(options.baseURL)}/cloudide/api/v3/trae/oauth/ExchangeToken`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cloudide-Token': '',
    },
    body: JSON.stringify({ RefreshToken: options.pat }),
    signal: options.abortSignal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Trae PAT exchange failed with ${response.status}${body ? `: ${body}` : ''}`)
  }

  const data = await response.json().catch((error) => {
    throw new Error(`Trae PAT exchange returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }) as Record<string, unknown>
  const code = data.code
  if (code !== 0) {
    const message = typeof data.message === 'string' && data.message ? data.message : 'unknown error'
    throw new Error(`Trae PAT exchange failed with code ${String(code)}: ${message}`)
  }

  const payload = data.Data && typeof data.Data === 'object' && !Array.isArray(data.Data)
    ? data.Data as Record<string, unknown>
    : undefined
  const token = typeof payload?.Token === 'string' ? payload.Token : undefined
  if (!token) throw new Error('Trae PAT exchange response did not include Data.Token')

  cachedPat = options.pat
  cachedToken = token
  cachedExpireAt = normalizeExpireAt(payload?.TokenExpireAt) ?? now + 30 * 60_000
  return { token, authorization: `Cloud-IDE-JWT ${token}` }
}

function normalizeExpireAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}
