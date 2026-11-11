import { describe, expect, it } from 'vitest'
import type { SessionSummary } from '@/types/api'
import {
    buildMissionApprovals,
    buildMissions,
    canArchiveWorker,
    canStopWorker,
    findMission,
    getMissionId
} from './missions'

function session(
    id: string,
    overrides: Partial<SessionSummary> = {},
    metadata: Partial<NonNullable<SessionSummary['metadata']>> = {}
): SessionSummary {
    return {
        id,
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { path: '/repo', ...metadata },
        metadataVersion: 0,
        agentStateVersion: 0,
        todosUpdatedAt: 0,
        todoProgress: null,
        pendingRequestsCount: 0,
        pendingRequestKinds: [],
        pendingRequests: [],
        backgroundTaskCount: 0,
        futureScheduledMessageCount: 0,
        nextScheduledAt: null,
        model: null,
        effort: null,
        ...overrides
    }
}

describe('missions grouping', () => {
    it('groups a worker under its peer parent and includes the manager row', () => {
        const missions = buildMissions([
            session('manager-1', { metadata: { path: '/repo', name: 'Release manager' } }),
            session('worker-1', {}, { parentSessionId: 'manager-1' })
        ])

        expect(missions).toHaveLength(1)
        expect(missions[0]?.id).toBe('manager-1')
        expect(missions[0]?.name).toBe('Release manager')
        expect(missions[0]?.manager?.id).toBe('manager-1')
        expect(missions[0]?.workers.map((worker) => worker.id)).toEqual(['worker-1'])
    })

    it('prefers missionId over parentSessionId', () => {
        expect(getMissionId(session('worker', {}, {
            missionId: 'mission-a',
            parentSessionId: 'manager-1'
        }))).toBe('mission-a')

        const missions = buildMissions([
            session('mission-a'),
            session('worker-1', {}, { missionId: 'mission-a', parentSessionId: 'manager-1' }),
            session('worker-2', {}, { parentSessionId: 'worker-1' })
        ])
        expect(missions).toHaveLength(1)
        expect(missions[0]?.workers.map((worker) => worker.id).sort()).toEqual(['worker-1', 'worker-2'])
    })

    it('derives child workers into the parent mission so a tree stays one mission', () => {
        const missions = buildMissions([
            session('manager-1', {}, {}),
            session('worker-1', {}, { parentSessionId: 'manager-1', missionId: 'manager-1' }),
            session('worker-2', {}, { parentSessionId: 'worker-1', missionId: 'manager-1' })
        ])

        expect(missions).toHaveLength(1)
        expect(missions[0]?.workers).toHaveLength(2)
    })

    it('ignores standalone sessions', () => {
        expect(buildMissions([session('standalone')])).toEqual([])
    })

    it('flags pending requests as needs_attention', () => {
        const missions = buildMissions([
            session('manager-1'),
            session('worker-1', { active: true, pendingRequestsCount: 1 }, { parentSessionId: 'manager-1' })
        ])

        expect(missions[0]?.status).toBe('needs_attention')
        expect(missions[0]?.pendingRequests).toBe(1)
    })

    it('marks archived-only missions as done', () => {
        const missions = buildMissions([
            session('manager-1', { metadata: { path: '/repo', lifecycleState: 'archived' } }),
            session('worker-1', {
                metadata: { path: '/repo', lifecycleState: 'archived', parentSessionId: 'manager-1' }
            })
        ])

        expect(missions[0]?.status).toBe('done')
    })

    it('flattens pending requests with permission/input kinds', () => {
        const approvals = buildMissionApprovals(
            [
                session('manager-1', { metadata: { path: '/repo', name: 'Manager' } }),
                session('worker-1')
            ],
            [
                { 'req-1': { tool: 'Bash', createdAt: 123 } },
                {
                    'req-2': { tool: 'AskUserQuestion' },
                    'req-3': { tool: 'ExitPlanMode' }
                }
            ]
        )

        expect(approvals).toEqual([
            {
                sessionId: 'manager-1',
                sessionName: 'Manager',
                requestId: 'req-1',
                tool: 'Bash',
                kind: 'permission',
                createdAt: 123
            },
            {
                sessionId: 'worker-1',
                sessionName: 'worker-1',
                requestId: 'req-2',
                tool: 'AskUserQuestion',
                kind: 'input',
                createdAt: null
            },
            {
                sessionId: 'worker-1',
                sessionName: 'worker-1',
                requestId: 'req-3',
                tool: 'ExitPlanMode',
                kind: 'input',
                createdAt: null
            }
        ])
    })

    it('only stops a worker with an in-flight turn', () => {
        expect(canStopWorker(session('idle', { active: true }))).toBe(false)
        expect(canStopWorker(session('working', { active: true, thinking: true }))).toBe(true)
    })

    it('only archives disconnected, non-archived workers', () => {
        expect(canArchiveWorker(session('connected', { active: true }))).toBe(false)
        expect(canArchiveWorker(session('offline'))).toBe(true)
        expect(canArchiveWorker(session('archived', {
            metadata: { path: '/repo', lifecycleState: 'archived' }
        }))).toBe(false)
    })

    it('finds a mission by id', () => {
        const missions = buildMissions([
            session('manager-1'),
            session('worker-1', {}, { parentSessionId: 'manager-1' })
        ])
        expect(findMission(missions, 'manager-1')?.id).toBe('manager-1')
        expect(findMission(missions, 'missing')).toBeNull()
    })
})
