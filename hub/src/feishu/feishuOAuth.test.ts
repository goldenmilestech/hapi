import { describe, expect, it } from 'bun:test'
import {
    exchangeFeishuCode,
    fetchFeishuUserInfo,
    loginWithFeishuCode,
    FeishuOAuthError,
    type FeishuFetch,
    type FeishuOAuthConfig
} from './feishuOAuth'

const config: FeishuOAuthConfig = {
    appId: 'cli_test',
    appSecret: 'app-secret',
    redirectUri: 'https://hub.example.com/auth/feishu',
    scope: 'contact:user.email:readonly',
    authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize',
    tokenUrl: 'https://accounts.feishu.cn/oauth/v3/token',
    userInfoUrl: 'https://open.feishu.cn/open-apis/authen/v1/user_info'
}

type FetchCall = { url: string; init?: RequestInit }

function fakeFetch(body: unknown, status = 200): { fetchImpl: FeishuFetch; calls: FetchCall[] } {
    const calls: FetchCall[] = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(input), init })
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
        })
    }) as FeishuFetch
    return { fetchImpl, calls }
}

describe('Feishu OAuth client', () => {
    it('exchanges the code with the v3 endpoint using form encoding', async () => {
        const { fetchImpl, calls } = fakeFetch({
            code: 0,
            access_token: 'u-access-token',
            token_type: 'Bearer'
        })

        const token = await exchangeFeishuCode(config, 'auth-code', fetchImpl)
        expect(token).toBe('u-access-token')

        expect(calls).toHaveLength(1)
        expect(calls[0].url).toBe(config.tokenUrl!)
        expect(calls[0].init?.method).toBe('POST')
        expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/x-www-form-urlencoded')
        const body = new URLSearchParams(String(calls[0].init?.body))
        expect(body.get('grant_type')).toBe('authorization_code')
        expect(body.get('client_id')).toBe('cli_test')
        expect(body.get('client_secret')).toBe('app-secret')
        expect(body.get('code')).toBe('auth-code')
        expect(body.get('redirect_uri')).toBe(config.redirectUri)
    })

    it('surfaces the Feishu error code without leaking the secret', async () => {
        const { fetchImpl } = fakeFetch({
            code: 20003,
            error: 'invalid_grant',
            error_description: 'The authorization code is not found.'
        }, 400)

        await expect(exchangeFeishuCode(config, 'used-code', fetchImpl)).rejects.toThrow(
            'The authorization code is not found.'
        )
        try {
            await exchangeFeishuCode(config, 'used-code', fetchImpl)
        } catch (error) {
            expect(error).toBeInstanceOf(FeishuOAuthError)
            expect((error as FeishuOAuthError).feishuCode).toBe(20003)
            expect(String(error)).not.toContain('app-secret')
        }
    })

    it('rejects malformed token responses', async () => {
        const fetchImpl = (async () => new Response('<html>bad gateway</html>', { status: 502 })) as FeishuFetch
        await expect(exchangeFeishuCode(config, 'code', fetchImpl)).rejects.toThrow('invalid JSON')
    })

    it('normalizes user_info fields and falls back to en_name', async () => {
        const { fetchImpl, calls } = fakeFetch({
            code: 0,
            msg: 'success',
            data: {
                open_id: 'ou_1',
                union_id: 'on_1',
                name: '',
                en_name: 'Alice',
                email: 'Alice@Corp.com',
                enterprise_email: 'alice@corp.com',
                avatar_url: 'https://example.com/a.png'
            }
        })

        const user = await fetchFeishuUserInfo(config, 'u-token', fetchImpl)
        expect(user).toEqual({
            openId: 'ou_1',
            unionId: 'on_1',
            userId: null,
            name: 'Alice',
            email: 'Alice@Corp.com',
            enterpriseEmail: 'alice@corp.com',
            avatarUrl: 'https://example.com/a.png'
        })
        expect(calls[0].init?.headers).toEqual({ authorization: 'Bearer u-token' })
    })

    it('rejects user_info errors', async () => {
        const { fetchImpl } = fakeFetch({ code: 20005, msg: 'The user access token passed is invalid.' }, 200)
        await expect(fetchFeishuUserInfo(config, 'bad', fetchImpl)).rejects.toThrow('invalid')
    })

    it('chains exchange and user_info for a login', async () => {
        let call = 0
        const fetchImpl = (async () => {
            call += 1
            if (call === 1) {
                return new Response(JSON.stringify({ code: 0, access_token: 'u-1' }), { status: 200 })
            }
            return new Response(JSON.stringify({
                code: 0,
                data: { open_id: 'ou_1', name: 'Alice', email: 'alice@corp.com' }
            }), { status: 200 })
        }) as FeishuFetch

        const user = await loginWithFeishuCode(config, 'code', fetchImpl)
        expect(user.openId).toBe('ou_1')
    })
})
