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

function formatExpiry(value: number | null): string {
    if (value === null) return '-'
    return new Date(value).toLocaleString()
}

export function SessionShareDialog(props: SessionShareDialogProps) {
    const { isOpen, onClose, sessionId, api } = props
    const { t } = useTranslation()
    const [mode, setMode] = useState<SessionShareMode>('chat')
    const [ttlHours, setTtlHours] = useState<number>(24)
    const [shares, setShares] = useState<SessionShareSummary[]>([])
    const [createdUrl, setCreatedUrl] = useState<string | null>(null)
    const [copied, setCopied] = useState(false)
    const [isCreating, setIsCreating] = useState(false)
    const [isLoading, setIsLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const refresh = useCallback(async () => {
        setIsLoading(true)
        try {
            const response = await api.listSessionShares(sessionId)
            setShares(response.shares)
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error))
        } finally {
            setIsLoading(false)
        }
    }, [api, sessionId])

    useEffect(() => {
        if (!isOpen) return
        setCreatedUrl(null)
        setCopied(false)
        setError(null)
        void refresh()
    }, [isOpen, refresh])

    const handleCreate = async () => {
        setIsCreating(true)
        setError(null)
        try {
            const response = await api.createSessionShare(sessionId, { mode, ttlHours })
            setCreatedUrl(response.share.url)
            setCopied(false)
            await refresh()
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error))
        } finally {
            setIsCreating(false)
        }
    }

    const handleCopy = async () => {
        if (!createdUrl) return
        try {
            await safeCopyToClipboard(createdUrl)
            setCopied(true)
        } catch {
            // Clipboard can be blocked (insecure context, permissions); the
            // URL is still selectable in the text box below.
        }
    }

    const handleRevoke = async (shareId: string) => {
        setError(null)
        try {
            await api.revokeSessionShare(sessionId, shareId)
            await refresh()
        } catch (error) {
            setError(error instanceof Error ? error.message : String(error))
        }
    }

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

                    {createdUrl ? (
                        <div className="space-y-2 rounded-lg border border-[var(--app-border)] p-3">
                            <div className="text-xs text-[var(--app-hint)]">{t('share.dialog.link')}</div>
                            <div className="flex items-center gap-2">
                                <input
                                    readOnly
                                    value={createdUrl}
                                    onFocus={(event) => event.currentTarget.select()}
                                    className="h-9 min-w-0 flex-1 rounded-md border border-[var(--app-border)] bg-[var(--app-bg)] px-2 text-xs"
                                />
                                <Button variant="secondary" size="sm" onClick={() => void handleCopy()}>
                                    {copied ? t('share.dialog.copied') : t('share.dialog.copy')}
                                </Button>
                            </div>
                            <p className="text-xs text-[var(--app-hint)]">
                                {t('share.dialog.linkOnce')}
                            </p>
                        </div>
                    ) : null}

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
                                {shares.map((share) => (
                                    <li
                                        key={share.id}
                                        className="flex items-center justify-between gap-2 rounded-md border border-[var(--app-border)] px-3 py-2"
                                    >
                                        <div className="min-w-0 text-xs">
                                            <div className="font-medium">
                                                {share.mode === 'chat_approve'
                                                    ? t('share.mode.chat_approve')
                                                    : t('share.mode.chat')}
                                            </div>
                                            <div className="text-[var(--app-hint)]">
                                                {t('share.dialog.expires', { time: formatExpiry(share.expiresAt) })}
                                            </div>
                                            {share.revokedAt ? (
                                                <div className="text-red-600">{t('share.dialog.revoked')}</div>
                                            ) : null}
                                        </div>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            disabled={Boolean(share.revokedAt)}
                                            onClick={() => void handleRevoke(share.id)}
                                        >
                                            {t('share.dialog.revoke')}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    )
}
