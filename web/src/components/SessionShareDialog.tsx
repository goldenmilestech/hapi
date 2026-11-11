import { useCallback, useEffect, useState } from 'react'
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { useTranslation } from '@/lib/use-translation'
import type { ApiClient } from '@/api/client'
import type { SessionShareMode, SessionShareSummary } from '@/types/api'

type SessionShareDialogProps = {
    isOpen: boolean
    onClose: () => void
    sessionId: string
    api: ApiClient
}

const TTL_OPTIONS = [
    { value: 1, labelKey: 'share.ttl.1h' },
    { value: 24, labelKey: 'share.ttl.24h' },
    { value: 168, labelKey: 'share.ttl.7d' }
] as const

type BusyAction = 'renew' | 'recover' | 'revoke'

function formatExpiry(value: number | null): string {
    if (value === null) return '-'
    return new Date(value).toLocaleString()
}

function isExpired(share: SessionShareSummary): boolean {
    return share.expiresAt !== null && share.expiresAt <= Date.now()
}

export function SessionShareDialog(props: SessionShareDialogProps) {
    const { isOpen, onClose, sessionId, api } = props
    const { t } = useTranslation()
    const [mode, setMode] = useState<SessionShareMode>('chat')
    const [ttlHours, setTtlHours] = useState<number>(24)
    const [shares, setShares] = useState<SessionShareSummary[]>([])
    const [copiedId, setCopiedId] = useState<string | null>(null)
    const [busy, setBusy] = useState<{ id: string; action: BusyAction } | null>(null)
    const [isCreating, setIsCreating] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const refresh = useCallback(async (silent = false) => {
        if (!silent) {
            setIsLoading(true)
        }
        try {
            const response = await api.listSessionShares(sessionId)
            setShares(response.shares)
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error))
        } finally {
            if (!silent) {
                setIsLoading(false)
            }
        }
    }, [api, sessionId])

    useEffect(() => {
        if (!isOpen) return
        setCopiedId(null)
        setBusy(null)
        setError(null)
        void refresh()
    }, [isOpen, refresh])

    const handleCreate = async () => {
        setIsCreating(true)
        setError(null)
        try {
            await api.createSessionShare(sessionId, { mode, ttlHours })
            await refresh()
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error))
        } finally {
            setIsCreating(false)
        }
    }

    const handleCopy = async (share: SessionShareSummary) => {
        if (!share.url) return
        try {
            await safeCopyToClipboard(share.url)
            setCopiedId(share.id)
        } catch {
            // Clipboard can be blocked (insecure context, permissions); the
            // URL is still selectable in the text box.
        }
    }

    const runShareAction = async (shareId: string, action: BusyAction, work: () => Promise<unknown>) => {
        setBusy({ id: shareId, action })
        setError(null)
        try {
            await work()
            // Keep the rows visible while renewing/recovering/revoking so the
            // per-row busy label is not replaced by the loading placeholder.
            await refresh(true)
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error))
        } finally {
            setBusy(null)
        }
    }

    const handleRenew = (shareId: string) => runShareAction(
        shareId,
        'renew',
        () => api.renewSessionShare(sessionId, shareId, { ttlHours })
    )

    const handleRecover = (shareId: string) => runShareAction(
        shareId,
        'recover',
        () => api.recoverSessionShare(sessionId, shareId)
    )

    const handleRevoke = (shareId: string) => runShareAction(
        shareId,
        'revoke',
        () => api.revokeSessionShare(sessionId, shareId)
    )

    return (
        <Dialog open={isOpen} onOpenChange={(open) => { if (!open) onClose() }}>
            <DialogContent className="max-w-xl">
                <DialogHeader>
                    <DialogTitle>{t('share.dialog.title')}</DialogTitle>
                </DialogHeader>

                <div className="mt-3 space-y-4 text-sm">
                    <p className="text-[var(--app-hint)]">
                        {t('share.dialog.description')}
                    </p>

                    <div className="grid grid-cols-2 gap-3">
                        <label className="space-y-1">
                            <span className="text-xs text-[var(--app-hint)]">{t('share.dialog.mode')}</span>
                            <select
                                value={mode}
                                onChange={(event) => setMode(event.target.value as SessionShareMode)}
                                className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2"
                            >
                                <option value="chat">{t('share.mode.chat')}</option>
                                <option value="chat_approve">{t('share.mode.chat_approve')}</option>
                            </select>
                        </label>
                        <label className="space-y-1">
                            <span className="text-xs text-[var(--app-hint)]">{t('share.dialog.ttl')}</span>
                            <select
                                value={ttlHours}
                                onChange={(event) => setTtlHours(Number(event.target.value))}
                                className="h-9 w-full rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2"
                            >
                                {TTL_OPTIONS.map((option) => (
                                    <option key={option.value} value={option.value}>
                                        {t(option.labelKey)}
                                    </option>
                                ))}
                            </select>
                        </label>
                    </div>

                    <div className="flex items-center gap-2">
                        <Button onClick={() => void handleCreate()} disabled={isCreating}>
                            {isCreating ? t('share.dialog.creating') : t('share.dialog.create')}
                        </Button>
                        <span className="text-xs text-[var(--app-hint)]">
                            {t('share.dialog.guestHint')}
                        </span>
                    </div>
                    <p className="text-xs text-[var(--app-hint)]">
                        {t('share.dialog.validityHint')}
                    </p>

                    {error ? (
                        <div className="rounded-md bg-red-600/10 p-2 text-xs text-red-600">{error}</div>
                    ) : null}

                    <div className="space-y-2">
                        <div className="text-xs font-medium">{t('share.dialog.existing')}</div>
                        {isLoading ? (
                            <div className="text-xs text-[var(--app-hint)]">{t('share.dialog.loading')}</div>
                        ) : shares.length === 0 ? (
                            <div className="text-xs text-[var(--app-hint)]">{t('share.dialog.none')}</div>
                        ) : (
                            <ul className="space-y-2">
                                {shares.map((share) => {
                                    const revoked = Boolean(share.revokedAt)
                                    const expired = isExpired(share)
                                    const rowBusy = busy?.id === share.id ? busy.action : null
                                    return (
                                        <li
                                            key={share.id}
                                            className="space-y-2 rounded-md border border-[var(--app-border)] px-3 py-2"
                                        >
                                            <div className="flex items-start justify-between gap-2">
                                                <div className="min-w-0 text-xs">
                                                    <div className="font-medium">
                                                        {share.mode === 'chat_approve'
                                                            ? t('share.mode.chat_approve')
                                                            : t('share.mode.chat')}
                                                    </div>
                                                    <div className={expired && !revoked ? 'text-red-600' : 'text-[var(--app-hint)]'}>
                                                        {expired && !revoked
                                                            ? t('share.dialog.expired', { time: formatExpiry(share.expiresAt) })
                                                            : t('share.dialog.expires', { time: formatExpiry(share.expiresAt) })}
                                                    </div>
                                                    {revoked ? (
                                                        <div className="text-red-600">{t('share.dialog.revoked')}</div>
                                                    ) : null}
                                                </div>
                                                <Button
                                                    variant="outline"
                                                    size="sm"
                                                    disabled={revoked || rowBusy !== null}
                                                    onClick={() => void handleRevoke(share.id)}
                                                >
                                                    {rowBusy === 'revoke'
                                                        ? t('share.dialog.revoking')
                                                        : t('share.dialog.revoke')}
                                                </Button>
                                            </div>

                                            {share.url ? (
                                                <div className="flex items-center gap-2">
                                                    <input
                                                        readOnly
                                                        value={share.url}
                                                        aria-label={t('share.dialog.link')}
                                                        onFocus={(event) => event.currentTarget.select()}
                                                        disabled={revoked}
                                                        className="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs"
                                                    />
                                                    <Button
                                                        variant="secondary"
                                                        size="sm"
                                                        disabled={revoked}
                                                        onClick={() => void handleCopy(share)}
                                                    >
                                                        {copiedId === share.id
                                                            ? t('share.dialog.copied')
                                                            : t('share.dialog.copy')}
                                                    </Button>
                                                </div>
                                            ) : !revoked ? (
                                                <div className="space-y-1 rounded-md bg-[var(--app-secondary-bg)] p-2 text-xs">
                                                    <div className="text-[var(--app-hint)]">
                                                        {t('share.dialog.linkUnavailable')}
                                                    </div>
                                                    <div className="text-[var(--app-hint)]">
                                                        {t('share.dialog.recoverHint')}
                                                    </div>
                                                    <Button
                                                        variant="secondary"
                                                        size="sm"
                                                        disabled={rowBusy !== null}
                                                        onClick={() => void handleRecover(share.id)}
                                                    >
                                                        {rowBusy === 'recover'
                                                            ? t('share.dialog.recovering')
                                                            : t('share.dialog.recover')}
                                                    </Button>
                                                </div>
                                            ) : null}

                                            {!revoked ? (
                                                <div className="flex justify-end">
                                                    <Button
                                                        variant="outline"
                                                        size="sm"
                                                        disabled={rowBusy !== null}
                                                        onClick={() => void handleRenew(share.id)}
                                                    >
                                                        {rowBusy === 'renew'
                                                            ? t('share.dialog.renewing')
                                                            : t('share.dialog.renew')}
                                                    </Button>
                                                </div>
                                            ) : null}
                                        </li>
                                    )
                                })}
                            </ul>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
