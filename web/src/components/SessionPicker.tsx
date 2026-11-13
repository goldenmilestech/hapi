import { useMemo, useState } from 'react'
import type { SessionSummary } from '@/types/api'
import { useTranslation } from '@/lib/use-translation'
import { getSessionTitle } from '@/lib/sessionTitle'
import {
    filterSessionsForPicker,
    getSessionPickerStatus,
    groupSessionsForPicker,
    type SessionPickerStatus
} from '@/lib/sessionPicker'
import { CheckIcon } from '@/components/settings/SettingsPrimitives'

const searchClassName = 'w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)]'

const STATUS_DOT: Record<SessionPickerStatus, string> = {
    running: 'bg-[var(--app-badge-success-text)] animate-pulse',
    pending: 'bg-[var(--app-badge-warning-text)] animate-pulse',
    active: 'bg-[var(--app-link)]',
    idle: 'bg-[var(--app-hint)]',
    offline: 'bg-[var(--app-border)]'
}

type SessionPickerProps = {
    sessions: SessionSummary[]
    selectedId: string
    boundSessionIds: ReadonlySet<string>
    onSelect: (sessionId: string) => void
}

export function SessionPicker(props: SessionPickerProps) {
    const { t, locale } = useTranslation()
    const [query, setQuery] = useState('')

    const groups = useMemo(() => {
        const filtered = filterSessionsForPicker(props.sessions, query)
        return groupSessionsForPicker(filtered, t('settings.feishu.bind.otherProject'))
    }, [props.sessions, query, t])

    const timeFormatter = useMemo(
        () => new Intl.DateTimeFormat(locale, {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        }),
        [locale]
    )

    const statusLabel = (status: SessionPickerStatus): string => {
        switch (status) {
            case 'running':
                return t('session.item.running')
            case 'pending':
                return t('session.item.pending')
            case 'active':
                return t('session.item.active')
            case 'idle':
                return t('session.item.idle')
            case 'offline':
                return t('settings.feishu.bind.status.offline')
        }
    }

    return (
        <div className="space-y-2">
            <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('settings.feishu.bind.searchPlaceholder')}
                aria-label={t('settings.feishu.bind.searchPlaceholder')}
                className={searchClassName}
            />

            <div
                role="listbox"
                aria-label={t('settings.feishu.bind.select')}
                className="max-h-72 overflow-y-auto rounded-lg border border-[var(--app-border)]"
            >
                {groups.length === 0 ? (
                    <div className="px-3 py-6 text-center text-sm text-[var(--app-hint)]">
                        {t('settings.feishu.bind.noResults')}
                    </div>
                ) : groups.map((group) => (
                    <div key={group.key}>
                        <div className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-3 py-1.5">
                            <span className="min-w-0 truncate text-[11px] font-medium uppercase tracking-wide text-[var(--app-hint)]" title={group.path || undefined}>
                                {group.label}
                            </span>
                            <span className="shrink-0 text-[11px] text-[var(--app-hint)]">{group.sessions.length}</span>
                        </div>
                        {group.sessions.map((session) => {
                            const selected = session.id === props.selectedId
                            const status = getSessionPickerStatus(session)
                            return (
                                <button
                                    key={session.id}
                                    type="button"
                                    role="option"
                                    aria-selected={selected}
                                    onClick={() => props.onSelect(session.id)}
                                    className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${selected ? 'bg-[var(--app-secondary-bg)]' : 'hover:bg-[var(--app-subtle-bg)]'}`}
                                >
                                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[status]}`} aria-hidden="true" />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex min-w-0 items-center gap-1.5">
                                            <span className={`truncate text-sm ${selected ? 'font-medium text-[var(--app-link)]' : 'text-[var(--app-fg)]'}`}>
                                                {getSessionTitle(session)}
                                            </span>
                                            {props.boundSessionIds.has(session.id) ? (
                                                <span className="shrink-0 rounded bg-[var(--app-subtle-bg)] px-1 py-0.5 text-[10px] leading-none text-[var(--app-hint)]">
                                                    {t('settings.feishu.bind.boundBadge')}
                                                </span>
                                            ) : null}
                                            {selected ? <CheckIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-link)]" /> : null}
                                        </span>
                                        <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-[var(--app-hint)]">
                                            <span>{statusLabel(status)}</span>
                                            <span aria-hidden="true">·</span>
                                            <span className="font-mono">{session.id.slice(0, 8)}</span>
                                            <span aria-hidden="true">·</span>
                                            <span>{timeFormatter.format(new Date(session.updatedAt))}</span>
                                        </span>
                                    </span>
                                </button>
                            )
                        })}
                    </div>
                ))}
            </div>
        </div>
    )
}
