import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { useTranslation } from '@/lib/use-translation'

function BackIcon() {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5" aria-hidden="true">
            <path d="m15 18-6-6 6-6" />
        </svg>
    )
}

export default function MissionsLayout() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const pathname = useLocation({ select: (location) => location.pathname })
    const isDetail = pathname !== '/missions' && pathname !== '/missions/'

    return (
        <div className="flex h-full min-h-0 flex-col bg-[var(--app-bg)]">
            <header className="shrink-0 border-b border-[var(--app-border)] bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto flex w-full max-w-content items-center gap-2 p-3">
                    <button
                        type="button"
                        onClick={() => navigate({ to: isDetail ? '/missions' : '/sessions' })}
                        aria-label={t('common.back')}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <h1 className="truncate text-lg font-semibold">{t('missions.title')}</h1>
                        <p className="truncate text-xs text-[var(--app-hint)]">{t('missions.subtitle')}</p>
                    </div>
                </div>
            </header>

            <main className="app-scroll-y min-h-0 flex-1">
                <div className="mx-auto w-full max-w-content px-3 py-3">
                    <Outlet />
                </div>
            </main>
        </div>
    )
}
