import { describe, expect, it, beforeEach } from 'bun:test'
import type { Session } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

/**
 * A runner may acknowledge a resume spawn by returning a child it recovered
 * from `resume-processes` after a restart. That child can be alive while its
 * Hub session socket is already gone, so the row never becomes active and
 * every later resume hits the same dedupe entry.
 *
 * Before the fix this surfaced as a bare "Session failed to become active" and
 * the only escape was to archive the row. The engine now stops the stale child
 * once and respawns. These tests pin the retry and the refusal to retry when
 * the old child cannot be proven stopped.
 */
describe('SyncEngine resume stale runner child recovery', () => {
    const NAMESPACE = 'default'
    const MACHINE_ID = 'machine-x'

    let store: Store
    let engine: SyncEngine
    let spawnCalls: number
    let stopCalls: Array<{ machineId: string; sessionId: string }>

    function installFakeRunner(options: {
        stopStatus: 'stopped' | 'already_gone' | 'still_alive' | 'unknown'
        activateAfterSpawn: number
    }): void {
        ;(engine as unknown as { machineCache: unknown }).machineCache = {
            getOnlineMachinesByNamespace: () => [
                { id: MACHINE_ID, metadata: { host: 'localhost' } }
            ],
            expireInactive: () => {}
        }
        ;(engine as unknown as { rpcGateway: unknown }).rpcGateway = {
            spawnSession: async (...args: unknown[]) => {
                spawnCalls += 1
                // existingSessionId precedes startingMode in rpcGateway.spawnSession.
                const existingSessionId = args[12]
                return { type: 'success' as const, sessionId: existingSessionId as string }
            },
            stopRunnerSession: async (machineId: string, sessionId: string) => {
                stopCalls.push({ machineId, sessionId })
                return options.stopStatus
            },
        }
        ;(engine as unknown as { waitForSessionActive: unknown }).waitForSessionActive =
            async () => spawnCalls >= options.activateAfterSpawn
    }

    function insertInactiveSession(sessionId: string): Session {
        const cache = (engine as unknown as { sessionCache: import('./sessionCache').SessionCache }).sessionCache
        return cache.getOrCreateSession(sessionId, {
            path: '/tmp/proj',
            host: 'localhost',
            machineId: MACHINE_ID,
            flavor: 'claude',
            claudeSessionId: 'claude-conv-1',
            startedBy: 'runner',
        }, null, NAMESPACE)
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        spawnCalls = 0
        stopCalls = []
    })

    it('stops the stale child and respawns once when the first spawn never activates', async () => {
        const sessionId = insertInactiveSession('resume-stale-child').id
        installFakeRunner({ stopStatus: 'stopped', activateAfterSpawn: 2 })

        const result = await engine.resumeSession(sessionId, NAMESPACE)

        expect(result).toEqual({ type: 'success', sessionId })
        expect(spawnCalls).toBe(2)
        expect(stopCalls).toEqual([{ machineId: MACHINE_ID, sessionId }])
        expect(engine.getSession(sessionId)?.active).toBe(true)
    })

    it('retries when the runner reports the stale child is already gone', async () => {
        const sessionId = insertInactiveSession('resume-stale-child-gone').id
        installFakeRunner({ stopStatus: 'already_gone', activateAfterSpawn: 2 })

        const result = await engine.resumeSession(sessionId, NAMESPACE)

        expect(result).toEqual({ type: 'success', sessionId })
        expect(spawnCalls).toBe(2)
    })

    it('refuses to respawn while the stale child may still be alive', async () => {
        const sessionId = insertInactiveSession('resume-stale-child-alive').id
        installFakeRunner({ stopStatus: 'still_alive', activateAfterSpawn: 2 })

        const result = await engine.resumeSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({
            type: 'error',
            message: 'Session failed to become active',
            code: 'resume_failed',
        })
        expect(spawnCalls).toBe(1)
        expect(stopCalls).toEqual([{ machineId: MACHINE_ID, sessionId }])
    })

    it('reports the retry spawn error instead of the generic activation timeout', async () => {
        const sessionId = insertInactiveSession('resume-stale-child-retry-error').id
        installFakeRunner({ stopStatus: 'stopped', activateAfterSpawn: 2 })
        ;(engine as unknown as { rpcGateway: { spawnSession: unknown } }).rpcGateway.spawnSession =
            async (...args: unknown[]) => {
                spawnCalls += 1
                if (spawnCalls === 1) {
                    const existingSessionId = args[12]
                    return { type: 'success' as const, sessionId: existingSessionId as string }
                }
                return { type: 'error' as const, message: 'runner rejected respawn', childStarted: false }
            }

        const result = await engine.resumeSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({
            type: 'error',
            message: 'runner rejected respawn',
            code: 'resume_failed',
        })
        expect(spawnCalls).toBe(2)
    })

    it('keeps the concurrent history-action guard distinct from an archived fork', async () => {
        const sessionId = insertInactiveSession('resume-history-busy').id
        installFakeRunner({ stopStatus: 'stopped', activateAfterSpawn: 2 })
        ;(engine as unknown as { historyActionsInFlight: Set<string> }).historyActionsInFlight.add(sessionId)

        const result = await engine.reopenSession(sessionId, NAMESPACE)

        expect(result).toMatchObject({
            type: 'error',
            message: 'Another conversation history action is in progress; retry shortly',
            code: 'resume_failed',
        })
        expect(spawnCalls).toBe(0)
    })
})
