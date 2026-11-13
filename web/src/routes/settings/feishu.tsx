import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { CreateFeishuBotBindCodeResponse, FeishuBotBindingSummary } from '@/types/api'
import type { ApiClient } from '@/api/client'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'
import { useSessions } from '@/hooks/queries/useSessions'
import { SessionPicker } from '@/components/SessionPicker'
import { SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'

const buttonClassName = 'rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-60'
const dangerButtonClassName = `${buttonClassName} text-red-600 dark:text-red-400`

function chatTypeLabel(chatType: string, t: (key: string) => string): string {
    if (chatType === 'p2p') return t('settings.feishu.bindings.chatType.p2p')
    if (chatType === 'group') return t('settings.feishu.bindings.chatType.group')
    return chatType
}

function BindingRow(props: {
    binding: FeishuBotBindingSummary
    api: ApiClient | null
    onRemoved: () => void
}) {
    const { t, locale } = useTranslation()
    const [error, setError] = useState<string | null>(null)
    const removeMutation = useMutation({
        mutationFn: async () => {
            if (!props.api) {
                throw new Error('API unavailable')
            }
            await props.api.removeFeishuBotBinding(props.binding.id)
        },
        onSuccess: () => {
            setError(null)
            props.onRemoved()
        },
        onError: () => setError(t('settings.feishu.bindings.unbindError'))
    })

    return (
        <div className="flex items-start justify-between gap-3 px-3 py-3">
            <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-[var(--app-fg)]">
                    {props.binding.sessionTitle}
                </div>
                <div className="mt-0.5 truncate text-xs leading-snug text-[var(--app-hint)]">
                    {props.binding.chatName || props.binding.chatId}
                    {' · '}
                    {chatTypeLabel(props.binding.chatType, t)}
                </div>
                <div className="mt-0.5 text-xs leading-snug text-[var(--app-hint)]">
                    {new Date(props.binding.createdAt).toLocaleString(locale)}
                </div>
                {error ? <div role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
            </div>
            <button
                type="button"
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate()}
                className={dangerButtonClassName}
            >
                {removeMutation.isPending
                    ? t('settings.feishu.bindings.unbinding')
                    : t('settings.feishu.bindings.unbind')}
            </button>
        </div>
    )
}

export default function SettingsFeishuPage() {
    const { t, locale } = useTranslation()
    const { api } = useAppContext()
    const queryClient = useQueryClient()
    const { sessions, isLoading: sessionsLoading } = useSessions(api)
    const [selectedSessionId, setSelectedSessionId] = useState('')
    const [bindCode, setBindCode] = useState<CreateFeishuBotBindCodeResponse | null>(null)
    const [copied, setCopied] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [boundNotice, setBoundNotice] = useState<string | null>(null)

    const configQuery = useQuery({
        queryKey: queryKeys.feishuConfig,
        queryFn: () => api!.getFeishuConfig(),
        enabled: Boolean(api)
    })
    const botEnabled = configQuery.data?.botEnabled === true

    const bindingsQuery = useQuery({
        queryKey: queryKeys.feishuBotBindings,
        queryFn: () => api!.getFeishuBotBindings(),
        enabled: Boolean(api) && botEnabled,
        // The chat side completes the binding asynchronously; poll only while
        // a code is live.
        refetchInterval: bindCode ? 3_000 : false
    })

    useEffect(() => {
        if (!bindCode) return
        const bound = bindingsQuery.data?.bindings.some(
            (binding) => binding.sessionId === bindCode.sessionId
        )
        if (!bound) return
        setBoundNotice(bindCode.sessionTitle)
        setBindCode(null)
        setSelectedSessionId('')
        void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
        void queryClient.invalidateQueries({ queryKey: queryKeys.session(bindCode.sessionId) })
    }, [bindCode, bindingsQuery.data, queryClient])

    const createCodeMutation = useMutation({
        mutationFn: async (sessionId: string) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            return await api.createFeishuBotBindCode({ sessionId })
        },
        onSuccess: (result) => {
            setBindCode({
                code: result.code,
                expiresAt: result.expiresAt,
                sessionId: result.sessionId,
                sessionTitle: result.sessionTitle
            })
            setBoundNotice(null)
            setError(null)
        },
        onError: () => setError(t('settings.feishu.bind.error'))
    })

    const boundSessionIds = useMemo(
        () => new Set((bindingsQuery.data?.bindings ?? []).map((binding) => binding.sessionId)),
        [bindingsQuery.data]
    )

    const refreshBindings = () => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.feishuBotBindings })
    }

    const copyCommand = async () => {
        if (!bindCode) return
        try {
            await navigator.clipboard.writeText(`/hapi bind ${bindCode.code}`)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
        } catch {
            setCopied(false)
        }
    }

    if (configQuery.isLoading) {
        return (
            <SettingsPageContent description={t('settings.feishu.description')}>
                <div className="text-sm text-[var(--app-hint)]">{t('loading')}</div>
            </SettingsPageContent>
        )
    }

    if (!botEnabled) {
        return (
            <SettingsPageContent description={t('settings.feishu.description')}>
                <SettingsSection title={t('settings.feishu.disabled.title')}>
                    <div className="space-y-2 px-3 py-3">
                        <p className="text-sm leading-snug text-[var(--app-hint)]">
                            {t('settings.feishu.disabled.description')}
                        </p>
                    </div>
                </SettingsSection>
            </SettingsPageContent>
        )
    }

    return (
        <SettingsPageContent description={t('settings.feishu.description')}>
            <SettingsSection title={t('settings.feishu.bindings.section')}>
                {bindingsQuery.isLoading ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('loading')}</div>
                ) : bindingsQuery.error ? (
                    <div role="alert" className="px-3 py-3 text-sm text-red-600 dark:text-red-400">
                        {t('settings.feishu.bindings.loadError')}
                    </div>
                ) : (bindingsQuery.data?.bindings.length ?? 0) === 0 ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">
                        {t('settings.feishu.bindings.empty')}
                    </div>
                ) : (
                    bindingsQuery.data?.bindings.map((binding) => (
                        <BindingRow
                            key={binding.id}
                            binding={binding}
                            api={api}
                            onRemoved={() => {
                                refreshBindings()
                                void queryClient.invalidateQueries({ queryKey: queryKeys.sessions })
                                void queryClient.invalidateQueries({ queryKey: queryKeys.session(binding.sessionId) })
                            }}
                        />
                    ))
                )}
            </SettingsSection>

            <SettingsSection title={t('settings.feishu.bind.title')}>
                <div className="space-y-2 px-3 py-3">
                    <p className="text-xs leading-snug text-[var(--app-hint)]">
                        {t('settings.feishu.bind.description')}
                    </p>

                    {boundNotice ? (
                        <div className="rounded-lg border border-[var(--app-border)] px-2 py-1.5 text-xs text-[var(--app-badge-success-text)]">
                            {t('settings.feishu.bind.success', { title: boundNotice })}
                        </div>
                    ) : null}

                    {bindCode ? (
                        <div className="space-y-2 rounded-lg border border-[var(--app-border)] px-3 py-2">
                            <div className="text-xs font-medium text-[var(--app-fg)]">
                                {t('settings.feishu.bind.codeTitle')}
                            </div>
                            <div className="text-xs leading-snug text-[var(--app-hint)]">
                                {t('settings.feishu.bind.codeHint')}
                            </div>
                            <code className="block break-all rounded-lg bg-[var(--app-subtle-bg)] px-2 py-1.5 font-mono text-sm text-[var(--app-fg)]">
                                /hapi bind {bindCode.code}
                            </code>
                            <div className="text-xs leading-snug text-[var(--app-hint)]">
                                {t('settings.feishu.bind.codeExpires', {
                                    time: new Date(bindCode.expiresAt).toLocaleTimeString(locale)
                                })}
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <button type="button" onClick={() => void copyCommand()} className={buttonClassName}>
                                    {copied ? t('settings.feishu.bind.copied') : t('settings.feishu.bind.copy')}
                                </button>
                                <button type="button" onClick={refreshBindings} className={buttonClassName}>
                                    {t('settings.feishu.bind.refresh')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setBindCode(null)}
                                    className={buttonClassName}
                                >
                                    {t('button.cancel')}
                                </button>
                            </div>
                            <div className="text-xs text-[var(--app-hint)]">
                                {t('settings.feishu.bind.waiting')}
                            </div>
                        </div>
                    ) : sessionsLoading ? (
                        <div className="text-sm text-[var(--app-hint)]">{t('loading')}</div>
                    ) : sessions.length === 0 ? (
                        <div className="text-sm text-[var(--app-hint)]">
                            {t('settings.feishu.bind.noSessions')}
                        </div>
                    ) : (
                        <>
                            <SessionPicker
                                sessions={sessions}
                                selectedId={selectedSessionId}
                                boundSessionIds={boundSessionIds}
                                onSelect={setSelectedSessionId}
                            />
                            {selectedSessionId && boundSessionIds.has(selectedSessionId) ? (
                                <div className="text-xs leading-snug text-[var(--app-badge-warning-text)]">
                                    {t('settings.feishu.bind.rebindWarning')}
                                </div>
                            ) : null}
                            <button
                                type="button"
                                disabled={!selectedSessionId || createCodeMutation.isPending}
                                onClick={() => createCodeMutation.mutate(selectedSessionId)}
                                className={buttonClassName}
                            >
                                {createCodeMutation.isPending
                                    ? t('settings.feishu.bind.generating')
                                    : t('settings.feishu.bind.generate')}
                            </button>
                        </>
                    )}

                    {error ? <div role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</div> : null}
                </div>
            </SettingsSection>
        </SettingsPageContent>
    )
}
