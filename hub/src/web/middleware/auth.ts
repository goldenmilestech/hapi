import type { MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { jwtVerify } from 'jose'

export type ShareMode = 'chat' | 'chat_approve'

export type WebAppEnv = {
    Variables: {
        userId: number
        namespace: string
        /** Set only for session-share JWTs: the single session they may touch. */
        sessionId?: string
        shareMode?: ShareMode
        /** Access-token row the JWT was issued from; null for legacy tokens. */
        tokenId?: string | null
    }
}

const jwtPayloadSchema = z.object({
    uid: z.number(),
    ns: z.string(),
    sid: z.string().optional(),
    mode: z.enum(['chat', 'chat_approve']).optional(),
    /** Access-token id, present only for JWTs minted from a hub-issued token. */
    tid: z.string().optional()
})

/**
 * Session share tokens are deliberately narrow. Anything not listed here is
 * rejected before it reaches a route handler, so a share link cannot be used
 * to reach another session, the terminal, git, settings or machine control.
 */
function isShareRequestAllowed(
    method: string,
    path: string,
    sessionId: string,
    mode: ShareMode | undefined,
    querySessionId: string | undefined
): boolean {
    if (path === '/api/events') {
        // A share subscription must name the shared session explicitly,
        // otherwise the SSE manager would stream every session in the
        // namespace.
        return method === 'GET' && querySessionId === sessionId
    }
    if (path === '/api/health' || path === '/api/machines' || path === '/api/sessions' || path === '/api/hub-settings') {
        return method === 'GET'
    }
    if (path === '/api/voice/backend' || path === '/api/voice/transcription/providers') {
        return method === 'GET'
    }
    if (path === '/api/visibility') {
        return method === 'POST'
    }

    const prefix = '/api/sessions/'
    if (!path.startsWith(prefix)) {
        return false
    }
    const rest = path.slice(prefix.length)
    const slashIndex = rest.indexOf('/')
    const rawId = slashIndex === -1 ? rest : rest.slice(0, slashIndex)
    let requestSessionId: string
    try {
        requestSessionId = decodeURIComponent(rawId)
    } catch {
        return false
    }
    if (requestSessionId !== sessionId) {
        return false
    }

    const subPath = slashIndex === -1 ? '' : rest.slice(slashIndex)
    if (subPath === '' || subPath === '/') {
        return method === 'GET'
    }

    const rules: Array<{ pattern: RegExp; methods: string[]; requireApprove?: boolean }> = [
        { pattern: /^\/messages$/, methods: ['GET', 'POST'] },
        { pattern: /^\/messages\/[^/]+$/, methods: ['DELETE'] },
        { pattern: /^\/outline$/, methods: ['GET'] },
        { pattern: /^\/messages\/queued-state$/, methods: ['POST'] },
        { pattern: /^\/messages\/[^/]+\/retry$/, methods: ['POST'] },
        { pattern: /^\/messages\/[^/]+\/steer$/, methods: ['POST'] },
        { pattern: /^\/slash-commands$/, methods: ['GET'] },
        { pattern: /^\/skills$/, methods: ['GET'] },
        { pattern: /^\/cursor-chat-store$/, methods: ['GET'] },
        { pattern: /^\/read-state$/, methods: ['PUT'] },
        { pattern: /^\/upload$/, methods: ['POST'] },
        { pattern: /^\/upload\/delete$/, methods: ['POST'] },
        {
            pattern: /^\/permissions\/[^/]+\/(approve|deny)$/,
            methods: ['POST'],
            requireApprove: true
        }
    ]

    return rules.some((rule) => (
        rule.pattern.test(subPath)
        && rule.methods.includes(method)
        && (!rule.requireApprove || mode === 'chat_approve')
    ))
}

export type AuthMiddlewareOptions = {
    /**
     * Consulted for JWTs minted from a hub-issued access token. Returning true
     * turns the request into a 401 immediately, so revocation does not have to
     * wait for the JWT to expire. Legacy-token JWTs carry no `tid` and are
     * unaffected.
     */
    isTokenRevoked?: (tokenId: string) => boolean
    /**
     * True when the namespace has an active access token. JWTs minted from the
     * legacy shared token carry no `tid`; once their namespace is claimed they
     * stop working, closing the up-to-4h window a previously exchanged JWT
     * would otherwise keep. Share JWTs (`sid`) are explicit grants and are not
     * affected.
     */
    isNamespaceClaimed?: (namespace: string) => boolean
}

export function createAuthMiddleware(
    jwtSecret: Uint8Array,
    options?: AuthMiddlewareOptions
): MiddlewareHandler<WebAppEnv> {
    return async (c, next) => {
        const path = c.req.path
        if (path === '/api/auth' || path === '/api/auth/feishu/config' || path === '/api/bind') {
            await next()
            return
        }

        const authorization = c.req.header('authorization')
        const tokenFromHeader = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined
        const tokenFromQuery = path === '/api/events' ? c.req.query().token : undefined
        const token = tokenFromHeader ?? tokenFromQuery

        if (!token) {
            return c.json({ error: 'Missing authorization token' }, 401)
        }

        try {
            const verified = await jwtVerify(token, jwtSecret, { algorithms: ['HS256'] })
            const parsed = jwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return c.json({ error: 'Invalid token payload' }, 401)
            }

            c.set('userId', parsed.data.uid)
            c.set('namespace', parsed.data.ns)
            c.set('tokenId', parsed.data.tid ?? null)

            if (parsed.data.tid && options?.isTokenRevoked?.(parsed.data.tid)) {
                return c.json({ error: 'Invalid token' }, 401)
            }

            if (
                !parsed.data.tid
                && !parsed.data.sid
                && options?.isNamespaceClaimed?.(parsed.data.ns)
            ) {
                return c.json({ error: 'Invalid token' }, 401)
            }

            if (parsed.data.sid) {
                const sessionId = parsed.data.sid
                c.set('sessionId', sessionId)
                c.set('shareMode', parsed.data.mode)
                if (!isShareRequestAllowed(
                    c.req.method,
                    path,
                    sessionId,
                    parsed.data.mode,
                    c.req.query().sessionId
                )) {
                    return c.json({ error: 'Share token does not grant access to this endpoint' }, 403)
                }
            }

            await next()
            return
        } catch {
            return c.json({ error: 'Invalid token' }, 401)
        }
    }
}
