import { classifyKind } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'

export type MissionStatus = 'active' | 'needs_attention' | 'idle' | 'done'

export type MissionSummary = {
    /** Stable grouping key: metadata.missionId, else the peer parent id. */
    id: string
    name: string
    /** The session whose id equals the mission id, when it is in the list. */
    manager: SessionSummary | null
    workers: SessionSummary[]
    sessions: SessionSummary[]
    activeWorkers: number
    thinkingWorkers: number
    pendingRequests: number
    todoTotal: number
    todoCompleted: number
    updatedAt: number
    status: MissionStatus
}

/**
 * Mission grouping is metadata-only: `missionId` wins, then the immediate
 * `parentSessionId` recorded from a peer spawn remit. Sessions without either
 * are ordinary standalone sessions and do not appear in the Missions console.
 */
export function getMissionId(session: SessionSummary): string | null {
    const missionId = session.metadata?.missionId
    if (missionId) return missionId
    const parentSessionId = session.metadata?.parentSessionId
    return parentSessionId || null
}

function missionName(missionId: string, manager: SessionSummary | null): string {
    const name = manager?.metadata?.name?.trim()
    if (name) return name
    const summary = manager?.metadata?.summary?.text?.trim()
    if (summary) return summary
    return `Mission ${missionId.slice(0, 8)}`
}

function deriveStatus(
    sessions: SessionSummary[],
    pendingRequests: number
): MissionStatus {
    if (pendingRequests > 0) return 'needs_attention'
    if (sessions.some((session) => session.active || session.thinking)) return 'active'
    if (sessions.length > 0 && sessions.every((session) => session.metadata?.lifecycleState === 'archived')) {
        return 'done'
    }
    return 'idle'
}

/**
 * Resolve a session's mission through its parent chain. A worker created by a
 * worker inherits the root manager's `missionId` when the intermediate session
 * has not been stamped yet, so a tree stays one mission instead of splitting at
 * every generation.
 */
function resolveMissionKey(
    session: SessionSummary,
    byId: Map<string, SessionSummary>,
    seen: Set<string>
): string | null {
    const direct = session.metadata?.missionId
    if (direct) return direct
    const parentId = session.metadata?.parentSessionId
    if (!parentId) return null
    if (seen.has(session.id)) return parentId
    seen.add(session.id)
    const parent = byId.get(parentId)
    if (!parent) return parentId
    return resolveMissionKey(parent, byId, seen) ?? parentId
}

export function buildMissions(sessions: SessionSummary[]): MissionSummary[] {
    const byId = new Map(sessions.map((session) => [session.id, session]))
    const grouped = new Map<string, SessionSummary[]>()

    for (const session of sessions) {
        const missionId = resolveMissionKey(session, byId, new Set())
        if (!missionId) continue
        const group = grouped.get(missionId)
        if (group) group.push(session)
        else grouped.set(missionId, [session])
    }

    // The manager normally has no missionId of its own; workers point at it.
    // Include it when the session list still has the row.
    for (const [missionId, group] of grouped) {
        const manager = byId.get(missionId)
        if (manager && !group.some((session) => session.id === manager.id)) {
            group.push(manager)
        }
    }

    return Array.from(grouped.entries())
        .map(([id, group]) => {
            const manager = byId.get(id) ?? null
            const workers = group.filter((session) => session.id !== id)
            const pendingRequests = group.reduce(
                (total, session) => total + (session.pendingRequestsCount ?? 0),
                0
            )
            const todoTotal = group.reduce(
                (total, session) => total + (session.todoProgress?.total ?? 0),
                0
            )
            const todoCompleted = group.reduce(
                (total, session) => total + (session.todoProgress?.completed ?? 0),
                0
            )
            const updatedAt = group.reduce(
                (latest, session) => Math.max(latest, session.updatedAt),
                0
            )

            return {
                id,
                name: missionName(id, manager),
                manager,
                workers,
                sessions: group,
                activeWorkers: workers.filter((session) => session.active).length,
                thinkingWorkers: workers.filter((session) => session.thinking).length,
                pendingRequests,
                todoTotal,
                todoCompleted,
                updatedAt,
                status: deriveStatus(group, pendingRequests)
            } satisfies MissionSummary
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function findMission(
    missions: MissionSummary[],
    missionId: string
): MissionSummary | null {
    return missions.find((mission) => mission.id === missionId) ?? null
}

export type MissionApproval = {
    sessionId: string
    sessionName: string
    requestId: string
    tool: string
    kind: 'permission' | 'input'
    createdAt: number | null
}

export type MissionApprovalRequest = {
    tool: string
    createdAt?: number | null
}

/**
 * Flatten pending requests from mission session details. The detail map is
 * authoritative; `SessionSummary.pendingRequests` is capped at five rows.
 */
export function buildMissionApprovals(
    sessions: SessionSummary[],
    requestsBySession: ReadonlyArray<Record<string, MissionApprovalRequest> | null | undefined>
): MissionApproval[] {
    return sessions.flatMap((session, index) => {
        const requests = requestsBySession[index] ?? {}
        return Object.entries(requests).map(([requestId, request]) => ({
            sessionId: session.id,
            sessionName: session.metadata?.name?.trim() || session.id.slice(0, 8),
            requestId,
            tool: request.tool,
            kind: classifyKind(request.tool),
            createdAt: request.createdAt ?? null
        }))
    })
}

/** Abort only an in-flight turn; an idle-but-connected session has nothing to stop. */
export function canStopWorker(session: SessionSummary): boolean {
    return session.thinking
}

/**
 * Archive only a disconnected, non-archived session. Runner-backed sessions
 * cannot be archived while the hub still considers them connected.
 */
export function canArchiveWorker(session: SessionSummary): boolean {
    return !session.active && session.metadata?.lifecycleState !== 'archived'
}
