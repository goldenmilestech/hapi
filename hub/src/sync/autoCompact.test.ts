import { describe, expect, it, spyOn } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine(): { store: Store; engine: SyncEngine } {
    const store = new Store(':memory:')
    const engine = new SyncEngine(
        store,
        {} as never,
        new RpcRegistry(),
        { broadcast() {} } as never
    )
    return { store, engine }
}

function createSession(engine: SyncEngine, flavor: string, tag: string) {
    return engine.getOrCreateSession(
        tag,
        { path: '/tmp/project', host: 'localhost', flavor },
        null,
        'default'
    )
}

function activate(engine: SyncEngine, sessionId: string): void {
    engine.handleSessionAlive({ sid: sessionId, time: Date.now() })
}

describe('hub-side auto-compaction', () => {
    it('sends the flavor compact command once when usage reaches the threshold', () => {
        const { engine } = createEngine()
        const session = createSession(engine, 'codex', 'auto-compact-codex')

        engine.setSessionContextLimit(session.id, 200_000)
        activate(engine, session.id)
        const send = spyOn(engine, 'sendMessage').mockResolvedValue(undefined)

        engine.handleAgentContextUsage(session.id, { contextTokens: 179_999 })
        expect(send).not.toHaveBeenCalled()

        engine.handleAgentContextUsage(session.id, { contextTokens: 180_000 })
        expect(send).toHaveBeenCalledWith(session.id, { text: '/compact', sentFrom: 'webapp' })

        engine.handleAgentContextUsage(session.id, { contextTokens: 181_000 })
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('uses /compress for Cursor and ignores sessions without a compact command', () => {
        const { engine } = createEngine()
        const cursor = createSession(engine, 'cursor', 'auto-compact-cursor')
        const copilot = createSession(engine, 'copilot', 'auto-compact-copilot')
        engine.setSessionContextLimit(cursor.id, 100_000)
        engine.setSessionContextLimit(copilot.id, 100_000)
        activate(engine, cursor.id)
        activate(engine, copilot.id)
        const send = spyOn(engine, 'sendMessage').mockResolvedValue(undefined)

        engine.handleAgentContextUsage(cursor.id, { contextTokens: 95_000 })
        expect(send).toHaveBeenCalledWith(cursor.id, { text: '/compress', sentFrom: 'webapp' })

        engine.handleAgentContextUsage(copilot.id, { contextTokens: 95_000 })
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('leaves Claude to its native auto-compact window', () => {
        const { engine } = createEngine()
        const session = createSession(engine, 'claude', 'auto-compact-claude')
        engine.setSessionContextLimit(session.id, 100_000)
        activate(engine, session.id)
        const send = spyOn(engine, 'sendMessage').mockResolvedValue(undefined)

        engine.handleAgentContextUsage(session.id, { contextTokens: 500_000 })
        expect(send).not.toHaveBeenCalled()
    })

    it('never exceeds the model window when the configured limit is larger', () => {
        const { engine } = createEngine()
        const session = createSession(engine, 'codex', 'auto-compact-window')
        engine.setSessionContextLimit(session.id, 1_000_000)
        activate(engine, session.id)
        const send = spyOn(engine, 'sendMessage').mockResolvedValue(undefined)

        // 90% of the 200k model window, not 90% of the 1M preference.
        engine.handleAgentContextUsage(session.id, { contextTokens: 179_000, contextWindow: 200_000 })
        expect(send).not.toHaveBeenCalled()
        engine.handleAgentContextUsage(session.id, { contextTokens: 180_000, contextWindow: 200_000 })
        expect(send).toHaveBeenCalledTimes(1)
    })

    it('compacts immediately when a limit is lowered below the last observed usage', () => {
        const { engine } = createEngine()
        const session = createSession(engine, 'codex', 'auto-compact-lower')
        engine.setSessionContextLimit(session.id, 1_000_000)
        activate(engine, session.id)
        const send = spyOn(engine, 'sendMessage').mockResolvedValue(undefined)

        engine.handleAgentContextUsage(session.id, { contextTokens: 500_000 })
        expect(send).not.toHaveBeenCalled()

        engine.setSessionContextLimit(session.id, 100_000)
        expect(send).toHaveBeenCalledWith(session.id, { text: '/compact', sentFrom: 'webapp' })
    })

    it('stops watching when the limit is cleared and rearms after usage drops', () => {
        const { engine } = createEngine()
        const session = createSession(engine, 'codex', 'auto-compact-clear')
        engine.setSessionContextLimit(session.id, 200_000)
        activate(engine, session.id)
        const send = spyOn(engine, 'sendMessage').mockResolvedValue(undefined)

        engine.handleAgentContextUsage(session.id, { contextTokens: 190_000 })
        expect(send).toHaveBeenCalledTimes(1)

        engine.handleAgentContextUsage(session.id, { contextTokens: 10_000 })
        engine.setSessionContextLimit(session.id, null)
        engine.handleAgentContextUsage(session.id, { contextTokens: 190_000 })
        expect(send).toHaveBeenCalledTimes(1)
    })
})
