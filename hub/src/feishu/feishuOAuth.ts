/**
 * Feishu (China) OAuth 2.0 web login.
 *
 * Flow: authorize page → code → token endpoint (v3) → user_info. The app
 * secret never leaves the hub. Codes and tokens are never logged.
 */
export const FEISHU_AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
export const FEISHU_TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token'
export const FEISHU_USER_INFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info'

const REQUEST_TIMEOUT_MS = 8_000

export type FeishuOAuthConfig = {
    appId: string
    appSecret: string
    redirectUri: string
    scope: string
    /** Test seams; production uses the constants above. */
    authorizeUrl?: string
    tokenUrl?: string
    userInfoUrl?: string
}

/** Narrow fetch shape so tests can inject a plain function. */
export type FeishuFetch = (input: string, init?: RequestInit) => Promise<Response>

export type FeishuUserInfo = {
    openId: string
    unionId: string | null
    userId: string | null
    name: string
    email: string | null
    enterpriseEmail: string | null
    avatarUrl: string | null
}

export class FeishuOAuthError extends Error {
    constructor(message: string, public readonly feishuCode?: number) {
        super(message)
        this.name = 'FeishuOAuthError'
    }
}

type TokenResponse = {
    code?: number
    access_token?: string
    error?: string
    error_description?: string
}

type UserInfoResponse = {
    code?: number
    msg?: string
    data?: {
        open_id?: string
        union_id?: string
        user_id?: string
        name?: string
        en_name?: string
        email?: string
        enterprise_email?: string
        avatar_url?: string
    }
}

function parseJson(text: string, endpoint: string): unknown {
    try {
        return JSON.parse(text) as unknown
    } catch {
        throw new FeishuOAuthError(`Feishu ${endpoint} returned invalid JSON`)
    }
}

export async function exchangeFeishuCode(
    config: FeishuOAuthConfig,
    code: string,
    fetchImpl: FeishuFetch = fetch
): Promise<string> {
    const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.appId,
        client_secret: config.appSecret,
        code,
        redirect_uri: config.redirectUri
    })

    const response = await fetchImpl(config.tokenUrl ?? FEISHU_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const payload = parseJson(await response.text(), 'token endpoint') as TokenResponse

    if (!response.ok || payload.code !== 0 || !payload.access_token) {
        throw new FeishuOAuthError(
            payload.error_description || payload.error || 'Feishu token exchange failed',
            payload.code
        )
    }
    return payload.access_token
}

export async function fetchFeishuUserInfo(
    config: FeishuOAuthConfig,
    accessToken: string,
    fetchImpl: FeishuFetch = fetch
): Promise<FeishuUserInfo> {
    const response = await fetchImpl(config.userInfoUrl ?? FEISHU_USER_INFO_URL, {
        method: 'GET',
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    const payload = parseJson(await response.text(), 'user_info endpoint') as UserInfoResponse
    const data = payload.data

    if (!response.ok || payload.code !== 0 || !data?.open_id) {
        throw new FeishuOAuthError(
            payload.msg || 'Feishu user_info request failed',
            payload.code
        )
    }

    return {
        openId: data.open_id,
        unionId: data.union_id ?? null,
        userId: data.user_id ?? null,
        name: data.name || data.en_name || data.email || data.open_id,
        email: data.email ?? null,
        enterpriseEmail: data.enterprise_email ?? null,
        avatarUrl: data.avatar_url ?? null
    }
}

export async function loginWithFeishuCode(
    config: FeishuOAuthConfig,
    code: string,
    fetchImpl: FeishuFetch = fetch
): Promise<FeishuUserInfo> {
    const accessToken = await exchangeFeishuCode(config, code, fetchImpl)
    return await fetchFeishuUserInfo(config, accessToken, fetchImpl)
}
