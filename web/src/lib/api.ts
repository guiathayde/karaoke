const TOKEN_KEY = 'karaoke.singerToken'
const SINGER_KEY = 'karaoke.singerId'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null) {
  try {
    if (value) localStorage.setItem(key, value)
    else localStorage.removeItem(key)
  } catch {
    /* armazenamento indisponível: segue sem persistir */
  }
}

export const getToken = () => read(TOKEN_KEY)
export const getSingerId = () => read(SINGER_KEY)
export function saveIdentity(token: string | null, singerId: string | null) {
  write(TOKEN_KEY, token)
  write(SINGER_KEY, singerId)
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  const token = getToken()
  if (token) headers['X-Singer-Token'] = token
  let body: string | undefined
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.body)
  }
  const res = await fetch(path, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body })
  if (!res.ok) {
    let detail = res.statusText
    try {
      const data = (await res.json()) as { detail?: unknown }
      if (typeof data.detail === 'string') detail = data.detail
    } catch {
      /* corpo não é JSON */
    }
    throw new ApiError(res.status, detail)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}
