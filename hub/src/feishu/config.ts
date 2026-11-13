import { getConfiguration } from '../configuration'
import {
    FEISHU_AUTHORIZE_URL,
    FEISHU_TOKEN_URL,
    FEISHU_USER_INFO_URL,
    type FeishuOAuthConfig
} from './feishuOAuth'
import type { FeishuIdentityConfig } from './identity'

export type ResolvedFeishuConfig = FeishuOAuthConfig & FeishuIdentityConfig

export type FeishuBotConfig = {
    appId: string
    appSecret: string
    verificationToken: string
    encryptKey: string | null
}

/**
 * Bot sending needs only the app credentials; the OAuth redirect URI is not
 * part of this flow. Keeping it separate lets an operator enable agent sends
 * even when web login is not configured.
 */
export type FeishuSendConfig = {
    appId: string
    appSecret: string
    ownerOpenId: string | null
    approvalTtlSeconds: number
    maxSendsPerMinute: number
}

function readPositiveInt(value: string | undefined, fallback: number, min: number, max: number): number {
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) {
        return fallback
    }
    return Math.min(max, Math.max(min, Math.floor(parsed)))
}

export function resolveFeishuSendConfig(): FeishuSendConfig | null {
    const configuration = getConfiguration()
    if (!configuration.feishuAppId || !configuration.feishuAppSecret) {
        return null
    }
    return {
        appId: configuration.feishuAppId,
        appSecret: configuration.feishuAppSecret,
        ownerOpenId: configuration.feishuOwnerOpenId,
        approvalTtlSeconds: readPositiveInt(
            process.env.FEISHU_SEND_APPROVAL_TTL_SECONDS,
            10 * 60,
            30,
            24 * 60 * 60
        ),
        maxSendsPerMinute: readPositiveInt(process.env.FEISHU_SEND_MAX_PER_MINUTE, 30, 1, 1_000)
    }
}

/** Safe to expose to the SPA; never includes the app secret. */
export type PublicFeishuConfig = {
    enabled: boolean
    botEnabled: boolean
    appId: string | null
    redirectUri: string | null
    scope: string
    authorizeUrl: string
}

export function resolveFeishuConfig(): ResolvedFeishuConfig | null {
    const configuration = getConfiguration()
    if (
        !configuration.feishuEnabled
        || !configuration.feishuAppId
        || !configuration.feishuAppSecret
        || !configuration.feishuRedirectUri
    ) {
        return null
    }
    return {
        appId: configuration.feishuAppId,
        appSecret: configuration.feishuAppSecret,
        redirectUri: configuration.feishuRedirectUri,
        scope: configuration.feishuScope,
        ownerOpenId: configuration.feishuOwnerOpenId,
        ownerEmail: configuration.feishuOwnerEmail,
        authorizeUrl: FEISHU_AUTHORIZE_URL,
        tokenUrl: FEISHU_TOKEN_URL,
        userInfoUrl: FEISHU_USER_INFO_URL
    }
}

export function resolveFeishuBotConfig(): FeishuBotConfig | null {
    const configuration = getConfiguration()
    if (
        !configuration.feishuAppId
        || !configuration.feishuAppSecret
        || !configuration.feishuVerificationToken
    ) {
        return null
    }
    return {
        appId: configuration.feishuAppId,
        appSecret: configuration.feishuAppSecret,
        verificationToken: configuration.feishuVerificationToken,
        encryptKey: configuration.feishuEncryptKey
    }
}

export function publicFeishuConfig(): PublicFeishuConfig {
    const configuration = getConfiguration()
    const enabled = resolveFeishuConfig() !== null
    return {
        enabled,
        botEnabled: configuration.feishuBotEnabled,
        appId: enabled ? configuration.feishuAppId : null,
        redirectUri: enabled ? configuration.feishuRedirectUri : null,
        scope: configuration.feishuScope,
        authorizeUrl: FEISHU_AUTHORIZE_URL
    }
}
