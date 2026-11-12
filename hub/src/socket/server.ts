import { Server as Engine } from '@socket.io/bun-engine'
import { Server, type DefaultEventsMap } from 'socket.io'
import { jwtVerify } from 'jose'
import { z } from 'zod'
import type { Store } from '../store'
import { getConfiguration } from '../configuration'
import { resolveHubAccessToken } from '../utils/accessTokenResolver'
import { registerCliHandlers } from './handlers/cli'
import { registerTerminalHandlers } from './handlers/terminal'
import { RpcRegistry } from './rpcRegistry'
import { SOCKET_MAX_HTTP_BUFFER_SIZE } from './socketLimits'
import type { BackgroundTask } from '@hapi/protocol/types'
import type { SyncEvent } from '../sync/syncEngine'
import { TerminalRegistry } from './terminalRegistry'
import { clearUserTerminalBuffer } from './userTerminalBuffer'
import type { CliSocketWithData, SocketData, SocketServer } from './socketTypes'

const jwtPayloadSchema = z.object({
    uid: z.number(),
    ns: z.string(),
    /** Access-token id, present only for JWTs minted from a hub-issued token. */
    tid: z.string().optional()
})

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60_000
const DEFAULT_MAX_TERMINALS = 4

function resolveEnvNumber(name: string, fallback: number): number {
    const raw = process.env[name]
    if (!raw) {
        return fallback
    }
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export type SocketServerDeps = {
    store: Store
    jwtSecret: Uint8Array
    corsOrigins?: string[]
    getSession?: (sessionId: string) => { active: boolean; namespace: string } | null
    onWebappEvent?: (event: SyncEvent) => void
    onSessionAlive?: (payload: { sid: string; time: number; thinking?: boolean; mode?: 'local' | 'remote' }) => void
    onSessionReady?: (payload: { sid: string; time: number }) => void
    onSessionEnd?: (payload: { sid: string; time: number }) => void
    onMachineAlive?: (payload: { machineId: string; time: number; health?: unknown }) => void
    onBackgroundTasks?: (sessionId: string, tasks: BackgroundTask[]) => void
    onSessionActivity?: (sessionId: string, updatedAt: number) => void
    onAgentProgress?: (sessionId: string, at: number) => void
    onSweepImmediateQueued?: (sessionId: string, now: number) => void
    onMessagesConsumed?: (sessionId: string) => void
    onUserMessage?: (sessionId: string) => void
    onAgentContextUsage?: (sessionId: string, usage: { contextTokens: number; contextWindow: number | null }) => void
}

export function createSocketServer(deps: SocketServerDeps): {
    io: SocketServer
    engine: Engine
    rpcRegistry: RpcRegistry
    /** Drops every live CLI/terminal socket authenticated by a revoked token. */
    disconnectAccessToken: (tokenId: string) => number
} {
    const configuration = getConfiguration()
    const corsOrigins = deps.corsOrigins ?? configuration.corsOrigins
    const allowAllOrigins = corsOrigins.includes('*')
    const corsOriginOption = allowAllOrigins ? '*' : corsOrigins
    const corsOptions = {
        origin: corsOriginOption,
        methods: ['GET', 'POST'],
        credentials: false
    }

    const io = new Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, SocketData>({
        cors: corsOptions,
        maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE
    })

    const engine = new Engine({
        path: '/socket.io/',
        cors: corsOptions,
        maxHttpBufferSize: SOCKET_MAX_HTTP_BUFFER_SIZE,
        allowRequest: async (req) => {
            const origin = req.headers.get('origin')
            if (!origin || allowAllOrigins || corsOrigins.includes(origin)) {
                return
            }
            throw 'Origin not allowed'
        }
    })
    io.bind(engine)

    const rpcRegistry = new RpcRegistry()
    const idleTimeoutMs = resolveEnvNumber('HAPI_TERMINAL_IDLE_TIMEOUT_MS', DEFAULT_IDLE_TIMEOUT_MS)
    const maxTerminals = resolveEnvNumber('HAPI_TERMINAL_MAX_TERMINALS', DEFAULT_MAX_TERMINALS)
    const maxTerminalsPerSocket = maxTerminals
    const maxTerminalsPerSession = maxTerminals
    const cliNs = io.of('/cli')
    const terminalNs = io.of('/terminal')
    const terminalRegistry = new TerminalRegistry({
        idleTimeoutMs,
        // Release the per-terminal scrollback buffer whenever a terminal is
        // genuinely removed (close / idle / CLI gone) so it
        // doesn't accumulate in the hub for the process's life. Reconnect
        // re-registers skip this (remove(id, false)) to keep their buffer.
        onRemove: (entry) => clearUserTerminalBuffer(entry.sessionId, entry.terminalId),
        onIdle: (entry) => {
            const terminalSocket = terminalNs.sockets.get(entry.socketId)
            terminalSocket?.emit('terminal:error', {
                terminalId: entry.terminalId,
                message: 'Terminal closed due to inactivity.'
            })
            const cliSocket = cliNs.sockets.get(entry.cliSocketId)
            cliSocket?.emit('terminal:close', {
                sessionId: entry.sessionId,
                terminalId: entry.terminalId
            })
        }
    })

    /**
     * Token id → live sockets, so revoking a token can drop its connections
     * immediately instead of waiting for the JWT to expire.
     */
    const socketsByToken = new Map<string, Set<{ disconnect: (close?: boolean) => void }>>()

    function trackTokenSocket(
        tokenId: string | null | undefined,
        socket: { disconnect: (close?: boolean) => void }
    ): () => void {
        if (!tokenId) {
            return () => {}
        }
        let sockets = socketsByToken.get(tokenId)
        if (!sockets) {
            sockets = new Set()
            socketsByToken.set(tokenId, sockets)
        }
        sockets.add(socket)
        return () => {
            sockets.delete(socket)
            if (sockets.size === 0) {
                socketsByToken.delete(tokenId)
            }
        }
    }

    function disconnectAccessToken(tokenId: string): number {
        const sockets = socketsByToken.get(tokenId)
        if (!sockets) {
            return 0
        }
        const count = sockets.size
        for (const socket of [...sockets]) {
            socket.disconnect(true)
        }
        socketsByToken.delete(tokenId)
        return count
    }

    cliNs.use((socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        const resolved = token ? resolveHubAccessToken(token, deps.store) : null
        if (!resolved) {
            return next(new Error('Invalid token'))
        }
        socket.data.namespace = resolved.namespace
        socket.data.tokenId = resolved.tokenId
        next()
    })
    cliNs.on('connection', (socket) => {
        // Close the tiny handshake→connection race: a revoke that landed after
        // the middleware ran must not leave a socket behind.
        if (socket.data.tokenId && deps.store.accessTokens.isTokenIdRevoked(socket.data.tokenId)) {
            socket.disconnect(true)
            return
        }
        const untrack = trackTokenSocket(socket.data.tokenId, socket)
        socket.once('disconnect', untrack)
        registerCliHandlers(socket as CliSocketWithData, {
            io,
            store: deps.store,
            rpcRegistry,
            terminalRegistry,
            onSessionAlive: deps.onSessionAlive,
            onSessionReady: deps.onSessionReady,
            onSessionEnd: deps.onSessionEnd,
            onMachineAlive: deps.onMachineAlive,
            onWebappEvent: deps.onWebappEvent,
            onBackgroundTasks: deps.onBackgroundTasks,
            onSessionActivity: deps.onSessionActivity,
            onAgentProgress: deps.onAgentProgress,
            onSweepImmediateQueued: deps.onSweepImmediateQueued,
            onMessagesConsumed: deps.onMessagesConsumed,
            onUserMessage: deps.onUserMessage,
            onAgentContextUsage: deps.onAgentContextUsage
        })
    })

    terminalNs.use(async (socket, next) => {
        const auth = socket.handshake.auth as Record<string, unknown> | undefined
        const token = typeof auth?.token === 'string' ? auth.token : null
        if (!token) {
            return next(new Error('Missing token'))
        }

        try {
            const verified = await jwtVerify(token, deps.jwtSecret, { algorithms: ['HS256'] })
            const parsed = jwtPayloadSchema.safeParse(verified.payload)
            if (!parsed.success) {
                return next(new Error('Invalid token payload'))
            }
            if (parsed.data.tid && deps.store.accessTokens.isTokenIdRevoked(parsed.data.tid)) {
                return next(new Error('Invalid token'))
            }
            // A namespace claimed by an access token is closed to JWTs minted
            // from the legacy shared token. Terminal JWTs carry no `sid`.
            if (!parsed.data.tid && deps.store.accessTokens.getActiveByNamespace(parsed.data.ns)) {
                return next(new Error('Invalid token'))
            }
            socket.data.userId = parsed.data.uid
            socket.data.namespace = parsed.data.ns
            socket.data.tokenId = parsed.data.tid ?? null
            next()
            return
        } catch {
            return next(new Error('Invalid token'))
        }
    })
    terminalNs.on('connection', (socket) => {
        if (socket.data.tokenId && deps.store.accessTokens.isTokenIdRevoked(socket.data.tokenId)) {
            socket.disconnect(true)
            return
        }
        const untrack = trackTokenSocket(socket.data.tokenId, socket)
        socket.once('disconnect', untrack)
        registerTerminalHandlers(socket, {
            io,
            getSession: (sessionId) => {
                return deps.getSession?.(sessionId) ?? deps.store.sessions.getSession(sessionId)
            },
            terminalRegistry,
            maxTerminalsPerSocket,
            maxTerminalsPerSession
        })
    })

    return { io, engine, rpcRegistry, disconnectAccessToken }
}
