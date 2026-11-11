import { useMemo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { useSessions } from '@/hooks/queries/useSessions'
import { buildMissions, type MissionStatus, type MissionSummary } from '@/lib/missions'
import { formatRelativeTime } from '@/lib/relativeTime'

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

function MissionCard(props: { mission: MissionSummary }) {
    const { mission } = props
    const { t } = useTranslation()
    const navigate = useNavigate()
    const done = mission.todoTotal > 0 ? mission.todoCompleted : 0
    const total = mission.todoTotal
    const percent = total > 0 ? Math.round((done / total) * 100) : 0
    const updated = formatRelativeTime(mission.updatedAt, t)

    return (
        <button
            type="button"
            onClick={() => navigate({ to: '/missions/$missionId', params: { missionId: mission.id } })}
            className="w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-3 py-3 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-[var(--app-fg)]">{mission.name}</div>
                    <div className="mt-0.5 truncate text-xs text-[var(--app-hint)]">
                        {t('missions.workerCount', { n: mission.workers.length })}
                        {mission.activeWorkers > 0
                            ? ` · ${t('missions.activeCount', { n: mission.activeWorkers })}`
                            : ''}
                        {mission.pendingRequests > 0
                            ? ` · ${t('missions.pendingCount', { n: mission.pendingRequests })}`
                            : ''}
                    </div>
                </div>
                <span className={`shrink-0 text-xs font-medium ${statusTone(mission.status)}`}>
                    {t(`missions.status.${mission.status}`)}
                </span>
            </div>

            {total > 0 ? (
                <div className="mt-3">
                    <div className="mb-1 flex items-center justify-between text-[11px] text-[var(--app-hint)]">
                        <span>{t('missions.progress', { done, total })}</span>
                        <span>{percent}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--app-subtle-bg)]">
                        <div className="h-full rounded-full bg-[var(--app-link)]" style={{ width: `${percent}%` }} />
                    </div>
                </div>
            ) : null}

            {updated ? (
                <div className="mt-2 text-[11px] text-[var(--app-hint)]">
                    {t('missions.updated', { time: updated })}
                </div>
            ) : null}
        </button>
    )
}

export default function MissionsListPage() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const { sessions, isLoading, error, refetch } = useSessions(api)
    const missions = useMemo(() => buildMissions(sessions), [sessions])

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
                <button
                    type="button"
                    onClick={() => void refetch()}
                    className="rounded-md bg-[var(--app-subtle-bg)] px-3 py-1.5 text-xs text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg-hover)]"
                >
                    {t('missions.refresh')}
                </button>
            </div>
        )
    }

    if (missions.length === 0) {
        return (
            <div className="flex flex-col items-center gap-2 py-12 text-center">
                <div className="text-sm font-medium text-[var(--app-fg)]">{t('missions.empty.title')}</div>
                <p className="max-w-md text-xs text-[var(--app-hint)]">{t('missions.empty.description')}</p>
            </div>
        )
    }

    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
                <div className="text-xs text-[var(--app-hint)]">
                    {t('missions.workerCount', { n: missions.reduce((total, mission) => total + mission.workers.length, 0) })}
                </div>
                <button
                    type="button"
                    onClick={() => void refetch()}
                    className="rounded-md px-2 py-1 text-xs text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                >
                    {t('missions.refresh')}
                </button>
            </div>
            {missions.map((mission) => (
                <MissionCard key={mission.id} mission={mission} />
            ))}
        </div>
    )
}
