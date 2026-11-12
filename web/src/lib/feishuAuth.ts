import type { FeishuPublicConfigResponse } from '@/types/api'

export const FEISHU_CALLBACK_PATH = '/auth/feishu'

const FEISHU_STATE_PREFIX = 'hapi_feishu_state::'
const FEISHU_ERROR_PREFIX = 'hapi_feishu_error::'

function storageKey(prefix: string, hubKey: string): string {
    return `${prefix}${hubKey}`
}

export function getFeishuHubKey(baseUrl: string): string {
    return `hapi_access_token::${baseUrl}`
}

export function getFeishuCallbackPath(): boolean {
    if (typeof window === 'undefined') {
        return false
    }
    return window.location.pathname.replace(/\/+$/, '') === FEISHU_CALLBACK_PATH
}

export function getFeishuCallbackParams(): { code: string | null; state: string | null; error: string | null } | null {
    if (!getFeishuCallbackPath()) {
        return null
    }
    const query = new URLSearchParams(window.location.search)
    return {
        code: query.get('code'),
        state: query.get('state'),
        error: query.get('error')
    }
}

export function createFeishuState(): string {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function storeFeishuState(hubKey: string, state: string): void {
    try {
        sessionStorage.setItem(storageKey(FEISHU_STATE_PREFIX, hubKey), state)
    } catch {
        // Ignore storage errors; the callback will fail the state check.
    }
}

/** Single-use: reading the expected state removes it. */
export function consumeFeishuState(hubKey: string): string | null {
    const key = storageKey(FEISHU_STATE_PREFIX, hubKey)
    try {
        const value = sessionStorage.getItem(key)
        sessionStorage.removeItem(key)
        return value
    } catch {
        return null
    }
}

export function storeFeishuError(hubKey: string, messageKey: string): void {
    try {
        sessionStorage.setItem(storageKey(FEISHU_ERROR_PREFIX, hubKey), messageKey)
    } catch {
        // Ignore storage errors.
    }
}

export function consumeFeishuError(hubKey: string): string | null {
    const key = storageKey(FEISHU_ERROR_PREFIX, hubKey)
    try {
        const value = sessionStorage.getItem(key)
        sessionStorage.removeItem(key)
        return value
    } catch {
        return null
    }
}

export function buildFeishuAuthorizeUrl(
    config: FeishuPublicConfigResponse,
    state: string
): string {
    if (!config.enabled || !config.appId || !config.redirectUri) {
        throw new Error('Feishu login is not configured')
    }
    const url = new URL(config.authorizeUrl)
    url.searchParams.set('client_id', config.appId)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('redirect_uri', config.redirectUri)
    if (config.scope) {
        url.searchParams.set('scope', config.scope)
    }
    url.searchParams.set('state', state)
    return url.toString()
}
