import { getConfiguration } from '../configuration'
import {
    FEISHU_AUTHORIZE_URL,
    FEISHU_TOKEN_URL,
    FEISHU_USER_INFO_URL,
    type FeishuOAuthConfig
} from './feishuOAuth'
import type { FeishuIdentityConfig } from './identity'

export type ResolvedFeishuConfig = FeishuOAuthConfig & FeishuIdentityConfig

/** Safe to expose to the SPA; never includes the app secret. */
export type PublicFeishuConfig = {
    enabled: boolean
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

export function publicFeishuConfig(): PublicFeishuConfig {
    const configuration = getConfiguration()
    const enabled = resolveFeishuConfig() !== null
    return {
        enabled,
        appId: enabled ? configuration.feishuAppId : null,
        redirectUri: enabled ? configuration.feishuRedirectUri : null,
        scope: configuration.feishuScope,
        authorizeUrl: FEISHU_AUTHORIZE_URL
    }
}
