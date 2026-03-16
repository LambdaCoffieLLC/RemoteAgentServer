export const authSchemes = ['operator-token', 'bootstrap-token'] as const

export type AuthScheme = (typeof authSchemes)[number]
export type AuthHeaderName = 'authorization' | 'x-bootstrap-token'

export interface TokenCredential {
  scheme: AuthScheme
  value: string
  headerName: AuthHeaderName
}

export interface AuthPolicy {
  required: boolean
  acceptedSchemes: readonly AuthScheme[]
}

export function createTokenCredential(scheme: AuthScheme, value: string): TokenCredential {
  return {
    scheme,
    value,
    headerName: scheme === 'bootstrap-token' ? 'x-bootstrap-token' : 'authorization',
  }
}

export function createAuthPolicy(acceptedSchemes: readonly AuthScheme[]): AuthPolicy {
  return {
    required: acceptedSchemes.length > 0,
    acceptedSchemes,
  }
}
