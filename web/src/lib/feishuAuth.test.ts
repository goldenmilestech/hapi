import { describe, expect, it } from 'vitest'
import { buildFeishuAuthorizeUrl, createFeishuState } from './feishuAuth'

const baseConfig = {
    enabled: true,
    botEnabled: false,
    appId: 'cli_test',
    redirectUri: 'https://hub.example.com/auth/feishu',
    scope: 'contact:user.email:readonly',
    authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
}

describe('Feishu login helpers', () => {
    it('builds the authorize URL with the required OAuth parameters', () => {
        const url = new URL(buildFeishuAuthorizeUrl(baseConfig, 'state-1'))

        expect(`${url.origin}${url.pathname}`).toBe(baseConfig.authorizeUrl)
        expect(url.searchParams.get('client_id')).toBe('cli_test')
        expect(url.searchParams.get('response_type')).toBe('code')
        expect(url.searchParams.get('redirect_uri')).toBe(baseConfig.redirectUri)
        expect(url.searchParams.get('scope')).toBe(baseConfig.scope)
        expect(url.searchParams.get('state')).toBe('state-1')
    })

    it('omits scope when it is empty', () => {
        const url = new URL(buildFeishuAuthorizeUrl({ ...baseConfig, scope: '' }, 'state-1'))
        expect(url.searchParams.has('scope')).toBe(false)
    })

    it('refuses to build a URL when Feishu is disabled', () => {
        expect(() => buildFeishuAuthorizeUrl({ ...baseConfig, enabled: false }, 'state-1')).toThrow()
        expect(() => buildFeishuAuthorizeUrl({ ...baseConfig, appId: null }, 'state-1')).toThrow()
    })

    it('creates a 128-bit hex state', () => {
        const first = createFeishuState()
        expect(first).toMatch(/^[0-9a-f]{32}$/)
        expect(createFeishuState()).not.toBe(first)
    })
})
