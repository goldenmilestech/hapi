import { SESSION_LIFECYCLE_IDLE } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import { getSessionProjectLabel, getSessionProjectPath } from '@/lib/sessionProjectLabel'
import { getSessionTitle } from '@/lib/sessionTitle'

export type SessionPickerStatus = 'running' | 'pending' | 'active' | 'idle' | 'offline'

export type SessionPickerGroup = {
    key: string
    path: string
    label: string
    sessions: SessionSummary[]
    latestUpdatedAt: number
}

export function getSessionPickerStatus(session: SessionSummary): SessionPickerStatus {
    if (!session.active) {
        return 'offline'
    }
    if (session.thinking || (session.backgroundTaskCount ?? 0) > 0) {
        return 'running'
    }
    if ((session.pendingRequestsCount ?? 0) > 0) {
        return 'pending'
    }
    if (session.metadata?.lifecycleState === SESSION_LIFECYCLE_IDLE) {
        return 'idle'
    }
    return 'active'
}

export function filterSessionsForPicker(sessions: SessionSummary[], query: string): SessionSummary[] {
    const needle = query.trim().toLowerCase()
    if (!needle) {
        return sessions
    }
    return sessions.filter((session) => {
        const path = getSessionProjectPath(session.metadata)
        const haystack = [
            getSessionTitle(session),
            session.id,
            path ?? '',
            path ? getSessionProjectLabel(path) : ''
        ]
        return haystack.some((value) => value.toLowerCase().includes(needle))
    })
}

function comparePickerSessions(a: SessionSummary, b: SessionSummary): number {
    if (a.active !== b.active) {
        return a.active ? -1 : 1
    }
    if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1
    }
    return b.updatedAt - a.updatedAt
}

/** Group search results by project, newest group first. */
export function groupSessionsForPicker(
    sessions: SessionSummary[],
    otherLabel = 'Other'
): SessionPickerGroup[] {
    const groups = new Map<string, SessionPickerGroup>()
    for (const session of sessions) {
        const path = getSessionProjectPath(session.metadata)
        const groupPath = path ?? ''
        const key = `${session.metadata?.machineId ?? ''}::${groupPath || otherLabel}`
        let group = groups.get(key)
        if (!group) {
            group = {
                key,
                path: groupPath,
                label: groupPath ? getSessionProjectLabel(groupPath) : otherLabel,
                sessions: [],
                latestUpdatedAt: 0
            }
            groups.set(key, group)
        }
        group.sessions.push(session)
        group.latestUpdatedAt = Math.max(group.latestUpdatedAt, session.updatedAt)
    }

    return Array.from(groups.values())
        .map((group) => ({
            ...group,
            sessions: [...group.sessions].sort(comparePickerSessions)
        }))
        .sort((a, b) => b.latestUpdatedAt - a.latestUpdatedAt)
}
