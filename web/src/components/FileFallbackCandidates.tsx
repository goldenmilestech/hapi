import type { FileSearchItem } from '@/types/api'
import { formatModifiedTime } from '@/lib/file-metadata'
import { useTranslation } from '@/lib/use-translation'

interface FileFallbackCandidatesProps {
    requestedPath: string
    candidates: FileSearchItem[]
    isSearching: boolean
    searchError?: string | null
    onSelect: (path: string) => void
}

export function FileFallbackCandidates(props: FileFallbackCandidatesProps) {
    const { t, locale } = useTranslation()

    return (
        <div className="space-y-3" data-hapi-file-fallback="true">
            <div className="text-sm text-[var(--app-hint)]">
                {t('file.fallback.notFound', { path: props.requestedPath })}
            </div>
            {props.candidates.length > 0 ? (
                <div className="overflow-hidden rounded-md border border-[var(--app-border)]">
                    <div className="border-b border-[var(--app-divider)] bg-[var(--app-subtle-bg)] px-3 py-2 text-xs text-[var(--app-hint)]">
                        {t('file.fallback.matches', { count: props.candidates.length })}
                    </div>
                    <ul>
                        {props.candidates.map((candidate) => {
                            const modified = formatModifiedTime(candidate.modified, locale)
                            return (
                                <li
                                    key={candidate.fullPath}
                                    className="border-b border-[var(--app-divider)] last:border-b-0"
                                >
                                    <button
                                        type="button"
                                        data-hapi-file-candidate={candidate.fullPath}
                                        onClick={() => props.onSelect(candidate.fullPath)}
                                        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-[var(--app-subtle-bg)]"
                                    >
                                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-[var(--app-fg)]">
                                            {candidate.fullPath}
                                        </span>
                                        {modified ? (
                                            <span className="shrink-0 text-[11px] text-[var(--app-hint)]">
                                                {modified}
                                            </span>
                                        ) : null}
                                    </button>
                                </li>
                            )
                        })}
                    </ul>
                </div>
            ) : props.isSearching ? (
                <div className="text-xs text-[var(--app-hint)]" role="status" aria-live="polite">
                    {t('file.fallback.searching')}
                </div>
            ) : props.searchError ? (
                <div className="text-xs text-[var(--app-hint)]">
                    {t('file.fallback.searchUnavailable')}
                </div>
            ) : (
                <div className="text-xs text-[var(--app-hint)]">
                    {t('file.fallback.noMatches')}
                </div>
            )}
        </div>
    )
}
