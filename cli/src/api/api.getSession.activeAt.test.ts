import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'

const axiosGetMock = vi.hoisted(() => vi.fn())

vi.mock('axios', () => ({
    default: {
        get: axiosGetMock,
        post: vi.fn()
    }
}))

vi.mock('@/api/auth', () => ({
    getAuthToken: () => 'cli-token'
}))

import { ApiClient } from './api'

describe('ApiClient.getSession activeAt coerce', () => {
    const now = 1_710_000_000_000

    beforeEach(() => {
        configuration._setApiUrl('https://hapi.example.com')
        configuration._setExtraHeaders({})
        axiosGetMock.mockReset()
    })

    it('accepts hub payloads with null activeAt without throwing', async () => {
        axiosGetMock.mockResolvedValue({
            data: {
                session: {
                    id: '11111111-1111-4111-8111-111111111111',
                    namespace: 'default',
                    seq: 1,
                    createdAt: now,
                    updatedAt: now,
                    active: false,
                    activeAt: null,
                    metadata: {
                        path: '/tmp/project',
                        host: 'test-host'
                    },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: now,
                    todos: [],
                    model: null,
                    modelReasoningEffort: null,
                    effort: null,
                    serviceTier: null
                }
            }
        })

        const client = await ApiClient.create()
        const session = await client.getSession('11111111-1111-4111-8111-111111111111')

        expect(session.activeAt).toBe(0)
        expect(typeof session.activeAt).toBe('number')
    })

    it('passes the persisted contextLimit through on reopen', async () => {
        axiosGetMock.mockResolvedValue({
            data: {
                session: {
                    id: '11111111-1111-4111-8111-111111111111',
                    namespace: 'default',
                    seq: 1,
                    createdAt: now,
                    updatedAt: now,
                    active: false,
                    activeAt: now,
                    metadata: {
                        path: '/tmp/project',
                        host: 'test-host'
                    },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: now,
                    todos: [],
                    model: null,
                    modelReasoningEffort: null,
                    effort: null,
                    serviceTier: null,
                    contextLimit: 200_000
                }
            }
        })

        const client = await ApiClient.create()
        const session = await client.getSession('11111111-1111-4111-8111-111111111111')

        // runClaude reads sessionInfo.contextLimit at bootstrap to export
        // CLAUDE_CODE_AUTO_COMPACT_WINDOW; dropping it here silently reverts
        // a reopened session to the model's native window.
        expect(session.contextLimit).toBe(200_000)
    })

    it('defaults a missing contextLimit to null', async () => {
        axiosGetMock.mockResolvedValue({
            data: {
                session: {
                    id: '11111111-1111-4111-8111-111111111111',
                    namespace: 'default',
                    seq: 1,
                    createdAt: now,
                    updatedAt: now,
                    active: false,
                    activeAt: now,
                    metadata: {
                        path: '/tmp/project',
                        host: 'test-host'
                    },
                    metadataVersion: 1,
                    agentState: null,
                    agentStateVersion: 0,
                    thinking: false,
                    thinkingAt: now,
                    todos: [],
                    model: null,
                    modelReasoningEffort: null,
                    effort: null,
                    serviceTier: null
                }
            }
        })

        const client = await ApiClient.create()
        const session = await client.getSession('11111111-1111-4111-8111-111111111111')

        expect(session.contextLimit).toBeNull()
    })
})
