import { useMemo, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import type { WorkGraphEvent } from '@hapi/protocol'
import type { SessionSummary } from '@/types/api'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useSessions } from '@/hooks/queries/useSessions'
import { queryKeys } from '@/lib/query-keys'
import {
    buildMissionApprovals,
    buildMissions,
    canArchiveWorker,
    canStopWorker,
    findMission,
    type MissionApproval,
    type MissionStatus
} from '@/lib/missions'
import { formatRelativeTime } from '@/lib/relativeTime'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { ArchiveSessionDialog } from '@/components/ArchiveSessionDialog'
import { useToast } from '@/lib/toast-context'

function sessionLabel(session: SessionSummary): string {
    return session.metadata?.name?.trim() || session.id.slice(0, 8)
}

function statusTone(status: MissionStatus): string {
    switch (status) {
        case 'needs_attention':
            return 'text-[var(--app-badge-warning-text)]'
        case 'active':
            return 'text-[var(--app-badge-success-text)]'
        case 'done':
            return 'text-[var(--app-link)]'
        default:
            return 'text-[var(--app-hint)]'
    }
}

function workerStatus(session: SessionSummary, t: (key: string) => string): string {
    if (session.thinking) return t('missions.worker.thinking')
    if (session.active) return t('missions.worker.idle')
    return t('missions.worker.offline')
}

function workerDot(session: SessionSummary): string {
    if (session.thinking) return 'bg-[var(--app-badge-warning-text)]'
    if (session.active) return 'bg-[var(--app-badge-success-text)]'
    return 'bg-[var(--app-hint)]'
}

function taskTone(status: string | undefined): string {
    if (status === 'completed') return 'text-[var(--app-badge-success-text)]'
    if (status === 'blocked') return 'text-red-600'
    if (status === 'in_progress') return 'text-[var(--app-link)]'
    return 'text-[var(--app-hint)]'
}

function taskDot(status: string | undefined): string {
    if (status === 'completed') return 'bg-[var(--app-badge-success-text)]'
    if (status === 'blocked') return 'bg-red-600'
    if (status === 'in_progress') return 'bg-[var(--app-link)]'
    return 'bg-[var(--app-hint)]'
}

function eventLabel(event: WorkGraphEvent, t: (key: string) => string): string {
    if (event.eventType === 'work_ad') return t('missions.event.work_ad')
    if (event.eventType === 'handoff') return t('missions.event.handoff')
    if (event.eventType === 'handoff_receipt') return t('missions.event.handoff_receipt')
    return t('missions.event.other')
}

export default function MissionDetailPage() {
    const { missionId } = useParams({ from: '/missions/$missionId' })
    const { api } = useAppContext()
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { sessions, isLoading, error } = useSessions(api)
    const missions = useMemo(() => buildMissions(sessions), [sessions])
    const mission = findMission(missions, missionId)
    const missionSessions = mission?.sessions ?? []

    const detailQueries = useQueries({
        queries: missionSessions.map((session) => ({
            queryKey: queryKeys.session(session.id),
            queryFn: () => api.getSession(session.id),
            enabled: Boolean(api),
            // The global `session-updated` subscription patches these detail
            // caches (including agentState requests); polling is only a
            // fallback for older hubs and reconnect gaps.
            refetchInterval: 30_000
        }))
    })

    const eventQueries = useQueries({
        queries: missionSessions.map((session) => ({
            queryKey: queryKeys.workGraphEvents(session.id),
            queryFn: () => api.getWorkGraphEvents(session.id, 100),
            enabled: Boolean(api),
            // `work-graph-updated` over SSE invalidates this query as rows land.
            // The interval only covers hubs that predate the event and reconnect
            // gaps the replay buffer could not close.
            refetchInterval: 30_000
        }))
    })

    const tasks = useMemo(() => {
        return detailQueries.flatMap((query, index) => {
            const session = missionSessions[index]
            const teamTasks = query.data?.session.teamState?.tasks ?? []
            return teamTasks.map((task) => ({
                ...task,
                sessionId: session.id,
                sessionName: session.metadata?.name ?? session.id.slice(0, 8)
            }))
        })
    }, [detailQueries, missionSessions])

    const events = useMemo(() => {
        return eventQueries
            .flatMap((query) => query.data?.events ?? [])
            .sort((a, b) => b.ts - a.ts)
    }, [eventQueries])

    const approvals = useMemo<MissionApproval[]>(() => {
        return buildMissionApprovals(
            missionSessions,
            detailQueries.map((query) => query.data?.session.agentState?.requests)
        )
    }, [detailQueries, missionSessions])

    const queryClient = useQueryClient()
    const { addToast } = useToast()
    const [busyApprovalKey, setBusyApprovalKey] = useState<string | null>(null)
    const [stopTarget, setStopTarget] = useState<SessionSummary | null>(null)
    const [archiveTarget, setArchiveTarget] = useState<SessionSummary | null>(null)
    const [workerActionPending, setWorkerActionPending] = useState(false)
    const [missionAction, setMissionAction] = useState<'stop-active' | 'archive-finished' | null>(null)
    const [missionActionPending, setMissionActionPending] = useState(false)

    if (isLoading) {
        return (
            <div className="flex h-40 items-center justify-center text-sm text-[var(--app-hint)]">
                {t('missions.loading')}
            </div>
        )
    }

    if (error) {
        return (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
                <div className="text-sm text-red-600">{t('missions.error')}</div>
                <div className="max-w-md text-xs text-[var(--app-hint)]">{error}</div>
            </div>
        )
    }

    if (!mission) {
        return (
            <div className="flex flex-col items-center gap-3 py-10 text-center">
                <div className="text-sm font-medium text-[var(--app-fg)]">{t('missions.notFound')}</div>
                <button
                    type="button"
                    onClick={() => navigate({ to: '/missions' })}
                    className="rounded-md bg-[var(--app-subtle-bg)] px-3 py-1.5 text-xs text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
                >
                    {t('missions.back')}
                </button>
            </div>
        )
    }

    const done = mission.todoTotal > 0 ? mission.todoCompleted : 0
    const percent = mission.todoTotal > 0 ? Math.round((done / mission.todoTotal) * 100) : 0
    const updated = formatRelativeTime(mission.updatedAt, t)
    const thinkingMissionWorkers = mission.sessions.filter((session) => (
        session.id !== mission.id && canStopWorker(session)
    ))
    const finishedMissionWorkers = mission.sessions.filter((session) => (
        session.id !== mission.id && canArchiveWorker(session)
    ))

    const invalidateSession = async (sessionId: string) => {
        await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.session(sessionId) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        ])
    }

    const handleApproval = async (item: MissionApproval, approve: boolean) => {
        setBusyApprovalKey(`${item.sessionId}:${item.requestId}`)
        try {
            if (approve) {
                await api.approvePermission(item.sessionId, item.requestId)
            } else {
                await api.denyPermission(item.sessionId, item.requestId)
            }
            await invalidateSession(item.sessionId)
            addToast({
                title: approve ? t('missions.approvals.approved') : t('missions.approvals.denied'),
                body: `${item.sessionName} · ${item.tool}`,
                sessionId: item.sessionId,
                url: `/sessions/${item.sessionId}`
            })
        } catch (actionError) {
            addToast({
                title: t('missions.approvals.failed'),
                body: actionError instanceof Error ? actionError.message : t('dialog.error.default'),
                sessionId: item.sessionId,
                url: `/sessions/${item.sessionId}`
            })
        } finally {
            setBusyApprovalKey(null)
        }
    }

    const handleStop = async (target: SessionSummary) => {
        setWorkerActionPending(true)
        try {
            await api.abortSession(target.id)
            await invalidateSession(target.id)
        } finally {
            setWorkerActionPending(false)
        }
    }

    const handleArchive = async (target: SessionSummary) => {
        setWorkerActionPending(true)
        try {
            await api.archiveSession(target.id)
            await invalidateSession(target.id)
        } finally {
            setWorkerActionPending(false)
        }
    }

    const handleStopAll = async () => {
        setMissionActionPending(true)
        try {
            const results = await Promise.allSettled(
                thinkingMissionWorkers.map((session) => api.abortSession(session.id))
            )
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            await Promise.all(thinkingMissionWorkers.map((session) => (
                queryClient.invalidateQueries({ queryKey: queryKeys.session(session.id) })
            )))
            const failed = results.filter((result) => result.status === 'rejected').length
            if (failed > 0) {
                throw new Error(t('missions.action.partialFailure', { n: failed }))
            }
        } finally {
            setMissionActionPending(false)
        }
    }

    const handleArchiveFinished = async () => {
        setMissionActionPending(true)
        try {
            const results = await Promise.allSettled(
                finishedMissionWorkers.map((session) => api.archiveSession(session.id))
            )
            await queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
            await Promise.all(finishedMissionWorkers.map((session) => (
                queryClient.invalidateQueries({ queryKey: queryKeys.session(session.id) })
            )))
            const failed = results.filter((result) => result.status === 'rejected').length
            if (failed > 0) {
                throw new Error(t('missions.action.partialFailure', { n: failed }))
            }
        } finally {
            setMissionActionPending(false)
        }
    }

    return (
        <div className="flex flex-col gap-4">
            <section className="rounded-lg border border-[var(--app-border)] px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="truncate text-base font-semibold text-[var(--app-fg)]">{mission.name}</h2>
                        <div className="mt-1 truncate font-mono text-[11px] text-[var(--app-hint)]">
                            {t('missions.missionId')}: {mission.id}
                        </div>
                    </div>
                    <span className={`shrink-0 text-xs font-medium ${statusTone(mission.status)}`}>
                        {t(`missions.status.${mission.status}`)}
                    </span>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                    <div className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-1.5">
                        <div className="text-[var(--app-hint)]">{t('missions.workers')}</div>
                        <div className="font-medium text-[var(--app-fg)]">{mission.workers.length}</div>
                    </div>
                    <div className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-1.5">
                        <div className="text-[var(--app-hint)]">{t('missions.activeCount', { n: mission.activeWorkers })}</div>
                        <div className="font-medium text-[var(--app-fg)]">{mission.activeWorkers}</div>
                    </div>
                    <div className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-1.5">
                        <div className="text-[var(--app-hint)]">{t('missions.pendingCount', { n: mission.pendingRequests })}</div>
                        <div className="font-medium text-[var(--app-fg)]">{mission.pendingRequests}</div>
                    </div>
                    <div className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-1.5">
                        <div className="text-[var(--app-hint)]">{t('missions.progress', { done, total: mission.todoTotal })}</div>
                        <div className="font-medium text-[var(--app-fg)]">{percent}%</div>
                    </div>
                </div>

                {updated ? (
                    <div className="mt-2 text-[11px] text-[var(--app-hint)]">
                        {t('missions.updated', { time: updated })}
                    </div>
                ) : null}

                {thinkingMissionWorkers.length > 0 || finishedMissionWorkers.length > 0 ? (
                    <div className="mt-3 flex flex-wrap gap-2">
                        {thinkingMissionWorkers.length > 0 ? (
                            <button
                                type="button"
                                onClick={() => setMissionAction('stop-active')}
                                className="rounded-md bg-[var(--app-subtle-bg)] px-2.5 py-1 text-xs text-red-600 transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
                            >
                                {t('missions.action.stopAll')}
                            </button>
                        ) : null}
                        {finishedMissionWorkers.length > 0 ? (
                            <button
                                type="button"
                                onClick={() => setMissionAction('archive-finished')}
                                className="rounded-md bg-[var(--app-subtle-bg)] px-2.5 py-1 text-xs text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
                            >
                                {t('missions.action.archiveFinished')}
                            </button>
                        ) : null}
                    </div>
                ) : null}
            </section>

            <section>
                <h3 className="mb-2 text-sm font-medium text-[var(--app-fg)]">{t('missions.approvals')}</h3>
                {approvals.length === 0 ? (
                    <div className="text-xs text-[var(--app-hint)]">{t('missions.approvals.empty')}</div>
                ) : (
                    <div className="flex flex-col gap-2">
                        {approvals.map((item) => (
                            <div
                                key={`${item.sessionId}:${item.requestId}`}
                                className="rounded-lg border border-[var(--app-border)] px-3 py-2"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="truncate text-sm text-[var(--app-fg)]">{item.tool}</div>
                                        <div className="truncate text-[11px] text-[var(--app-hint)]">
                                            {item.sessionName}
                                            {' · '}
                                            {item.kind === 'input'
                                                ? t('missions.approvals.needsInput')
                                                : t('missions.approvals.permission')}
                                            {item.createdAt
                                                ? ` · ${formatRelativeTime(item.createdAt, t) ?? ''}`
                                                : ''}
                                        </div>
                                    </div>
                                    <div className="flex shrink-0 items-center gap-1">
                                        {item.kind === 'permission' ? (
                                            <>
                                                <button
                                                    type="button"
                                                    disabled={busyApprovalKey !== null}
                                                    onClick={() => void handleApproval(item, true)}
                                                    className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-badge-success-text)] transition-colors hover:bg-[var(--app-subtle-bg-hover)] disabled:opacity-50"
                                                >
                                                    {busyApprovalKey === `${item.sessionId}:${item.requestId}`
                                                        ? '…'
                                                        : t('missions.approvals.approve')}
                                                </button>
                                                <button
                                                    type="button"
                                                    disabled={busyApprovalKey !== null}
                                                    onClick={() => void handleApproval(item, false)}
                                                    className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-red-600 transition-colors hover:bg-[var(--app-subtle-bg-hover)] disabled:opacity-50"
                                                >
                                                    {t('missions.approvals.deny')}
                                                </button>
                                            </>
                                        ) : (
                                            <button
                                                type="button"
                                                onClick={() => navigate({
                                                    to: '/sessions/$sessionId',
                                                    params: { sessionId: item.sessionId }
                                                })}
                                                className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-link)] transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
                                            >
                                                {t('missions.approvals.open')}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <section>
                <h3 className="mb-2 text-sm font-medium text-[var(--app-fg)]">{t('missions.workers')}</h3>
                <div className="flex flex-col gap-2">
                    {mission.sessions.map((session) => {
                        const isArchived = session.metadata?.lifecycleState === 'archived'
                        return (
                            <div
                                key={session.id}
                                className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--app-border)] px-3 py-2 transition-colors hover:bg-[var(--app-subtle-bg)]"
                            >
                                <button
                                    type="button"
                                    onClick={() => navigate({ to: '/sessions/$sessionId', params: { sessionId: session.id } })}
                                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                                >
                                    <span className={`h-2 w-2 shrink-0 rounded-full ${workerDot(session)}`} />
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center gap-2">
                                            <span className="truncate text-sm text-[var(--app-fg)]">
                                                {sessionLabel(session)}
                                            </span>
                                            {session.id === mission.id ? (
                                                <span className="shrink-0 rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">
                                                    {t('missions.manager')}
                                                </span>
                                            ) : null}
                                        </div>
                                        <div className="truncate text-[11px] text-[var(--app-hint)]">
                                            {[
                                                session.metadata?.flavor,
                                                workerStatus(session, t),
                                                session.metadata?.path
                                            ].filter(Boolean).join(' · ')}
                                        </div>
                                    </div>
                                    <span className="shrink-0 text-[11px] text-[var(--app-hint)]">
                                        {t('missions.openSession')}
                                    </span>
                                </button>
                                <div className="flex shrink-0 items-center gap-1">
                                    {canStopWorker(session) ? (
                                        <button
                                            type="button"
                                            onClick={() => setStopTarget(session)}
                                            className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-red-600 transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
                                        >
                                            {t('missions.action.stop')}
                                        </button>
                                    ) : null}
                                    {canArchiveWorker(session) ? (
                                        <button
                                            type="button"
                                            onClick={() => setArchiveTarget(session)}
                                            className="rounded-md bg-[var(--app-subtle-bg)] px-2 py-1 text-xs text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
                                        >
                                            {t('missions.action.archive')}
                                        </button>
                                    ) : null}
                                    {isArchived ? (
                                        <span className="text-[11px] text-[var(--app-hint)]">
                                            {t('missions.worker.archived')}
                                        </span>
                                    ) : null}
                                </div>
                            </div>
                        )
                    })}
                </div>
            </section>

            <section>
                <h3 className="mb-2 text-sm font-medium text-[var(--app-fg)]">{t('missions.tasks')}</h3>
                {tasks.length === 0 ? (
                    <div className="text-xs text-[var(--app-hint)]">{t('missions.noTasks')}</div>
                ) : (
                    <div className="flex flex-col gap-1">
                        {tasks.map((task, index) => (
                            <div key={`${task.sessionId}:${task.id ?? index}`} className="flex items-start gap-2 text-xs">
                                <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${taskDot(task.status)}`} />
                                <div className="min-w-0">
                                    <div className={`truncate ${taskTone(task.status)}`}>{task.title}</div>
                                    <div className="truncate text-[11px] text-[var(--app-hint)]">
                                        {task.sessionName}{task.owner ? ` · ${task.owner}` : ''}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </section>

            <section>
                <h3 className="mb-2 text-sm font-medium text-[var(--app-fg)]">{t('missions.timeline')}</h3>
                {events.length === 0 ? (
                    <div className="text-xs text-[var(--app-hint)]">{t('missions.noTimeline')}</div>
                ) : (
                    <div className="flex flex-col gap-2">
                        {events.slice(0, 50).map((event) => (
                            <div key={event.id} className="rounded-md border border-[var(--app-border)] px-2 py-1.5 text-xs">
                                <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium text-[var(--app-fg)]">{eventLabel(event, t)}</span>
                                    <span className="shrink-0 text-[11px] text-[var(--app-hint)]">
                                        {formatRelativeTime(event.ts, t) ?? ''}
                                    </span>
                                </div>
                                {event.summary ? (
                                    <div className="mt-0.5 text-[var(--app-fg)]">{event.summary}</div>
                                ) : null}
                                <div className="mt-0.5 truncate font-mono text-[10px] text-[var(--app-hint)]">
                                    {event.relatedSessionId ?? event.sourceRef}
                                </div>
                                {(event.artifactRefs ?? []).length > 0 ? (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                        {(event.artifactRefs ?? []).map((artifact, index) => (
                                            <span key={`${artifact.kind}:${artifact.url ?? artifact.ref ?? index}`} className="rounded bg-[var(--app-subtle-bg)] px-1.5 py-0.5 text-[10px] text-[var(--app-hint)]">
                                                {artifact.title ?? artifact.kind}
                                            </span>
                                        ))}
                                    </div>
                                ) : null}
                            </div>
                        ))}
                    </div>
                )}
            </section>

            {stopTarget ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setStopTarget(null)}
                    title={t('missions.action.stop.title')}
                    description={t('missions.action.stop.description', { name: sessionLabel(stopTarget) })}
                    confirmLabel={t('missions.action.stop.confirm')}
                    confirmingLabel={t('missions.action.stop.confirming')}
                    isPending={workerActionPending}
                    destructive
                    centerTitle
                    onConfirm={async () => {
                        if (stopTarget) await handleStop(stopTarget)
                    }}
                />
            ) : null}

            {archiveTarget ? (
                <ArchiveSessionDialog
                    isOpen={true}
                    onClose={() => setArchiveTarget(null)}
                    sessionId={archiveTarget.id}
                    sessionName={sessionLabel(archiveTarget)}
                    active={archiveTarget.active}
                    isPending={workerActionPending}
                    onConfirm={async () => {
                        if (archiveTarget) await handleArchive(archiveTarget)
                    }}
                />
            ) : null}

            {missionAction === 'stop-active' ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setMissionAction(null)}
                    title={t('missions.action.stopAll.title')}
                    description={t('missions.action.stopAll.description', { n: thinkingMissionWorkers.length })}
                    confirmLabel={t('missions.action.stopAll.confirm')}
                    confirmingLabel={t('missions.action.stopAll.confirming')}
                    isPending={missionActionPending}
                    destructive
                    centerTitle
                    onConfirm={handleStopAll}
                />
            ) : null}

            {missionAction === 'archive-finished' ? (
                <ConfirmDialog
                    isOpen={true}
                    onClose={() => setMissionAction(null)}
                    title={t('missions.action.archiveFinished.title')}
                    description={t('missions.action.archiveFinished.description', { n: finishedMissionWorkers.length })}
                    confirmLabel={t('missions.action.archiveFinished.confirm')}
                    confirmingLabel={t('missions.action.archiveFinished.confirming')}
                    isPending={missionActionPending}
                    centerTitle
                    onConfirm={handleArchiveFinished}
                />
            ) : null}
        </div>
    )
}
