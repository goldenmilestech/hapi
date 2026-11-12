import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
    AccessTokenSummary,
    CreateAccessTokenResponse,
    FeishuEmailBindingSummary,
    PersonalAccessTokenResponse
} from '@/types/api'
import { ApiError, type ApiClient } from '@/api/client'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { queryKeys } from '@/lib/query-keys'
import { getNamespaceFromToken } from '@/lib/jwt'
import { SettingsPageContent, SettingsSection } from '@/components/settings/SettingsPrimitives'

const inputClassName = 'w-full rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm text-[var(--app-fg)] outline-none focus:border-[var(--app-link)] disabled:opacity-60'
const buttonClassName = 'rounded-lg border border-[var(--app-border)] px-3 py-1.5 text-sm text-[var(--app-fg)] transition-colors hover:bg-[var(--app-subtle-bg)] disabled:opacity-60'
const dangerButtonClassName = `${buttonClassName} text-red-600 dark:text-red-400`

function formatTime(ms: number | null, locale: string, never: string): string {
    return ms === null ? never : new Date(ms).toLocaleString(locale)
}

function CopyTokenButton(props: { token: string; label: string; copiedLabel: string }) {
    const [copied, setCopied] = useState(false)

    async function copy() {
        try {
            await navigator.clipboard.writeText(props.token)
            setCopied(true)
            window.setTimeout(() => setCopied(false), 2000)
        } catch {
            setCopied(false)
        }
    }

    return (
        <button type="button" onClick={copy} className={buttonClassName}>
            {copied ? props.copiedLabel : props.label}
        </button>
    )
}

function TokenRow(props: { api: ApiClient | null; info: AccessTokenSummary }) {
    const { t, locale } = useTranslation()
    const queryClient = useQueryClient()
    const [confirming, setConfirming] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [revealedToken, setRevealedToken] = useState<string | null>(null)
    const [revealing, setRevealing] = useState(false)

    const revoked = props.info.revokedAt !== null
    const expired = props.info.expiresAt !== null && props.info.expiresAt <= Date.now()
    const status = revoked
        ? t('settings.tokens.list.revoked')
        : expired
            ? t('settings.tokens.list.expired')
            : t('settings.tokens.list.active')

    const revokeMutation = useMutation({
        mutationFn: async () => {
            if (!props.api) {
                throw new Error('API unavailable')
            }
            await props.api.revokeAccessToken(props.info.id)
        },
        onSuccess: () => {
            setConfirming(false)
            setError(null)
            void queryClient.invalidateQueries({ queryKey: queryKeys.accessTokens })
        },
        onError: () => setError(t('settings.tokens.list.error'))
    })

    async function reveal() {
        if (!props.api) {
            return
        }
        setRevealing(true)
        setError(null)
        try {
            const result = await props.api.getAccessTokenById(props.info.id)
            setRevealedToken(result.token)
        } catch (revealError) {
            setError(
                revealError instanceof ApiError && revealError.status === 409
                    ? t('settings.tokens.list.unrecoverable')
                    : t('settings.tokens.list.viewError')
            )
        } finally {
            setRevealing(false)
        }
    }

    return (
        <div className="px-3 py-3">
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-[var(--app-fg)]">{props.info.name}</div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs leading-snug text-[var(--app-hint)]">
                        <span>{t('settings.tokens.list.namespace')}: {props.info.namespace}</span>
                        <span className="font-mono">{props.info.tokenPrefix}…</span>
                        <span>{status}</span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs leading-snug text-[var(--app-hint)]">
                        <span>{t('settings.tokens.list.created')}: {formatTime(props.info.createdAt, locale, t('settings.tokens.list.neverUsed'))}</span>
                        <span>{t('settings.tokens.list.lastUsed')}: {formatTime(props.info.lastUsedAt, locale, t('settings.tokens.list.neverUsed'))}</span>
                    </div>
                    {revealedToken ? (
                        <div className="mt-2 space-y-1">
                            <code className="block break-all rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5 font-mono text-xs text-[var(--app-fg)]">
                                {revealedToken}
                            </code>
                            <div className="flex gap-2">
                                <CopyTokenButton
                                    token={revealedToken}
                                    label={t('settings.tokens.created.copy')}
                                    copiedLabel={t('settings.tokens.created.copied')}
                                />
                                <button type="button" onClick={() => setRevealedToken(null)} className={buttonClassName}>
                                    {t('settings.tokens.list.hide')}
                                </button>
                            </div>
                        </div>
                    ) : null}
                </div>
                {revoked ? null : confirming ? (
                    <div className="flex shrink-0 gap-2">
                        <button
                            type="button"
                            disabled={revokeMutation.isPending}
                            onClick={() => revokeMutation.mutate()}
                            className={dangerButtonClassName}
                        >
                            {revokeMutation.isPending ? t('settings.tokens.list.revoking') : t('settings.tokens.list.confirmRevoke')}
                        </button>
                        <button
                            type="button"
                            disabled={revokeMutation.isPending}
                            onClick={() => setConfirming(false)}
                            className={buttonClassName}
                        >
                            {t('button.cancel')}
                        </button>
                    </div>
                ) : (
                    <div className="flex shrink-0 gap-2">
                        {revealedToken ? null : (
                            <button
                                type="button"
                                disabled={revealing}
                                onClick={reveal}
                                className={buttonClassName}
                            >
                                {revealing ? t('settings.tokens.list.viewing') : t('settings.tokens.list.view')}
                            </button>
                        )}
                        <button type="button" onClick={() => setConfirming(true)} className={dangerButtonClassName}>
                            {t('settings.tokens.list.revoke')}
                        </button>
                    </div>
                )}
            </div>
            {error ? <div role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">{error}</div> : null}
        </div>
    )
}

function MyTokenSection(props: {
    api: ApiClient | null
    namespace: string
    updateAccessToken: (token: string) => void
}) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [confirming, setConfirming] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const tokenQuery = useQuery({
        queryKey: queryKeys.personalAccessToken,
        queryFn: () => props.api!.getPersonalAccessToken(),
        enabled: Boolean(props.api)
    })

    function handleSuccess(result: PersonalAccessTokenResponse) {
        if (result.token) {
            props.updateAccessToken(result.token)
        }
        setConfirming(false)
        setError(null)
        void queryClient.invalidateQueries({ queryKey: queryKeys.personalAccessToken })
        void queryClient.invalidateQueries({ queryKey: queryKeys.accessTokens })
    }

    const createMutation = useMutation({
        mutationFn: () => props.api!.createPersonalAccessToken(),
        onSuccess: handleSuccess,
        onError: () => setError(t('settings.tokens.mine.createError'))
    })

    const regenerateMutation = useMutation({
        mutationFn: () => props.api!.regeneratePersonalAccessToken(),
        onSuccess: handleSuccess,
        onError: () => setError(t('settings.tokens.mine.regenerateError'))
    })

    const data = tokenQuery.data

    return (
        <SettingsSection title={t('settings.tokens.mine.section')}>
            <div className="space-y-2 px-3 py-3">
                <div className="text-xs leading-snug text-[var(--app-hint)]">
                    {t('settings.tokens.mine.namespace')}: <span className="font-mono">{props.namespace}</span>
                </div>

                {tokenQuery.isLoading ? (
                    <div className="text-sm text-[var(--app-hint)]">{t('loading')}</div>
                ) : tokenQuery.error ? (
                    <div role="alert" className="text-sm text-red-600 dark:text-red-400">
                        {t('settings.tokens.mine.loadError')}
                    </div>
                ) : !data?.tokenInfo ? (
                    <>
                        <p className="text-xs leading-snug text-[var(--app-hint)]">
                            {t('settings.tokens.mine.none')}
                        </p>
                        <button
                            type="button"
                            disabled={createMutation.isPending}
                            onClick={() => createMutation.mutate()}
                            className={buttonClassName}
                        >
                            {createMutation.isPending
                                ? t('settings.tokens.mine.creating')
                                : t('settings.tokens.mine.create')}
                        </button>
                    </>
                ) : (
                    <>
                        <p className="text-xs leading-snug text-[var(--app-hint)]">
                            {t('settings.tokens.mine.hint')}
                        </p>
                        {data.token ? (
                            <div className="space-y-2">
                                <code className="block break-all rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5 font-mono text-xs text-[var(--app-fg)]">
                                    {data.token}
                                </code>
                                <CopyTokenButton
                                    token={data.token}
                                    label={t('settings.tokens.created.copy')}
                                    copiedLabel={t('settings.tokens.created.copied')}
                                />
                            </div>
                        ) : (
                            <div className="text-xs leading-snug text-red-600 dark:text-red-400">
                                {t('settings.tokens.mine.unrecoverable')}
                            </div>
                        )}
                        <p className="text-xs leading-snug text-[var(--app-hint)]">
                            {t('settings.tokens.mine.regenerateWarning')}
                        </p>
                        {confirming ? (
                            <div className="flex flex-wrap gap-2">
                                <button
                                    type="button"
                                    disabled={regenerateMutation.isPending}
                                    onClick={() => regenerateMutation.mutate()}
                                    className={dangerButtonClassName}
                                >
                                    {regenerateMutation.isPending
                                        ? t('settings.tokens.mine.regenerating')
                                        : t('settings.tokens.mine.confirmRegenerate')}
                                </button>
                                <button
                                    type="button"
                                    disabled={regenerateMutation.isPending}
                                    onClick={() => setConfirming(false)}
                                    className={buttonClassName}
                                >
                                    {t('button.cancel')}
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                onClick={() => setConfirming(true)}
                                className={dangerButtonClassName}
                            >
                                {t('settings.tokens.mine.regenerate')}
                            </button>
                        )}
                    </>
                )}

                {error ? <div role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</div> : null}
            </div>
        </SettingsSection>
    )
}

function AdminTokensSection(props: { api: ApiClient | null }) {
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const [name, setName] = useState('')
    const [namespace, setNamespace] = useState('')
    const [created, setCreated] = useState<CreateAccessTokenResponse | null>(null)
    const [createError, setCreateError] = useState<string | null>(null)

    const tokensQuery = useQuery({
        queryKey: queryKeys.accessTokens,
        queryFn: () => props.api!.getAccessTokens(),
        enabled: Boolean(props.api)
    })

    const createMutation = useMutation({
        mutationFn: async () => {
            if (!props.api) {
                throw new Error('API unavailable')
            }
            return await props.api.createAccessToken({ name: name.trim(), namespace: namespace.trim() })
        },
        onSuccess: (result) => {
            setCreated(result)
            setCreateError(null)
            setName('')
            setNamespace('')
            void queryClient.invalidateQueries({ queryKey: queryKeys.accessTokens })
        },
        onError: (error) => {
            setCreateError(
                error instanceof ApiError && error.status === 409
                    ? t('settings.tokens.create.namespaceTaken')
                    : t('settings.tokens.create.error')
            )
        }
    })

    const canSubmit = name.trim().length > 0 && namespace.trim().length > 0 && !createMutation.isPending

    return (
        <>
            <SettingsSection title={t('settings.tokens.create.section')}>
                <div className="space-y-2 px-3 py-3">
                    <input
                        value={name}
                        maxLength={64}
                        onChange={(event) => setName(event.target.value)}
                        placeholder={t('settings.tokens.create.namePlaceholder')}
                        aria-label={t('settings.tokens.create.name')}
                        className={inputClassName}
                    />
                    <input
                        value={namespace}
                        maxLength={64}
                        onChange={(event) => setNamespace(event.target.value)}
                        placeholder={t('settings.tokens.create.namespacePlaceholder')}
                        aria-label={t('settings.tokens.create.namespace')}
                        className={`${inputClassName} font-mono`}
                    />
                    <p className="text-xs leading-snug text-[var(--app-hint)]">
                        {t('settings.tokens.create.namespaceHint')}
                    </p>
                    <button
                        type="button"
                        disabled={!canSubmit}
                        onClick={() => createMutation.mutate()}
                        className={buttonClassName}
                    >
                        {createMutation.isPending ? t('settings.tokens.create.creating') : t('settings.tokens.create.submit')}
                    </button>
                    {createError ? <div role="alert" className="text-xs text-red-600 dark:text-red-400">{createError}</div> : null}
                </div>
            </SettingsSection>

            {created ? (
                <SettingsSection title={t('settings.tokens.created.title')}>
                    <div className="space-y-2 px-3 py-3">
                        <p className="text-xs leading-snug text-[var(--app-hint)]">{t('settings.tokens.created.hint')}</p>
                        <code className="block break-all rounded-lg border border-[var(--app-border)] bg-[var(--app-subtle-bg)] px-2 py-1.5 font-mono text-xs text-[var(--app-fg)]">
                            {created.token}
                        </code>
                        <div className="flex flex-wrap gap-2">
                            <CopyTokenButton
                                token={created.token}
                                label={t('settings.tokens.created.copy')}
                                copiedLabel={t('settings.tokens.created.copied')}
                            />
                            <button type="button" onClick={() => setCreated(null)} className={buttonClassName}>
                                {t('settings.tokens.created.dismiss')}
                            </button>
                        </div>
                        <div className="break-all text-xs leading-snug text-[var(--app-hint)]">
                            {t('settings.tokens.created.usage')}
                        </div>
                    </div>
                </SettingsSection>
            ) : null}

            <SettingsSection title={t('settings.tokens.list.section')}>
                {tokensQuery.isLoading ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('loading')}</div>
                ) : tokensQuery.error ? (
                    <div role="alert" className="px-3 py-3 text-sm text-red-600 dark:text-red-400">
                        {t('settings.tokens.list.loadError')}
                    </div>
                ) : (tokensQuery.data?.tokens.length ?? 0) === 0 ? (
                    <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('settings.tokens.list.empty')}</div>
                ) : (
                    tokensQuery.data?.tokens.map((info) => (
                        <TokenRow key={info.id} api={props.api} info={info} />
                    ))
                )}
            </SettingsSection>
        </>
    )
}

function FeishuBindingsSection(props: { api: ApiClient | null }) {
    const { t, locale } = useTranslation()
    const queryClient = useQueryClient()
    const [email, setEmail] = useState('')
    const [namespace, setNamespace] = useState('')
    const [error, setError] = useState<string | null>(null)

    const bindingsQuery = useQuery({
        queryKey: queryKeys.feishuBindings,
        queryFn: () => props.api!.getFeishuBindings(),
        enabled: Boolean(props.api)
    })

    const addMutation = useMutation({
        mutationFn: async () => {
            if (!props.api) {
                throw new Error('API unavailable')
            }
            return await props.api.addFeishuBinding({
                email: email.trim(),
                namespace: namespace.trim()
            })
        },
        onSuccess: () => {
            setEmail('')
            setNamespace('')
            setError(null)
            void queryClient.invalidateQueries({ queryKey: queryKeys.feishuBindings })
        },
        onError: () => setError(t('settings.tokens.feishu.addError'))
    })

    const removeMutation = useMutation({
        mutationFn: async (target: string) => {
            if (!props.api) {
                throw new Error('API unavailable')
            }
            await props.api.removeFeishuBinding(target)
        },
        onSuccess: () => {
            setError(null)
            void queryClient.invalidateQueries({ queryKey: queryKeys.feishuBindings })
        },
        onError: () => setError(t('settings.tokens.feishu.removeError'))
    })

    const canSubmit = email.trim().length > 0 && namespace.trim().length > 0 && !addMutation.isPending

    return (
        <SettingsSection title={t('settings.tokens.feishu.section')}>
            <div className="space-y-2 px-3 py-3">
                <p className="text-xs leading-snug text-[var(--app-hint)]">
                    {t('settings.tokens.feishu.description')}
                </p>
                <p className="text-xs leading-snug text-[var(--app-hint)]">
                    {t('settings.tokens.feishu.ownerHint')}
                </p>
                <input
                    value={email}
                    maxLength={254}
                    onChange={(event) => setEmail(event.target.value)}
                    placeholder={t('settings.tokens.feishu.emailPlaceholder')}
                    aria-label={t('settings.tokens.feishu.email')}
                    className={inputClassName}
                />
                <input
                    value={namespace}
                    maxLength={64}
                    onChange={(event) => setNamespace(event.target.value)}
                    placeholder={t('settings.tokens.create.namespacePlaceholder')}
                    aria-label={t('settings.tokens.feishu.namespaceLabel')}
                    className={`${inputClassName} font-mono`}
                />
                <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => addMutation.mutate()}
                    className={buttonClassName}
                >
                    {addMutation.isPending ? t('settings.tokens.feishu.adding') : t('settings.tokens.feishu.add')}
                </button>
                {error ? <div role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</div> : null}
            </div>

            {bindingsQuery.isLoading ? (
                <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('loading')}</div>
            ) : bindingsQuery.error ? (
                <div role="alert" className="px-3 py-3 text-sm text-red-600 dark:text-red-400">
                    {t('settings.tokens.feishu.loadError')}
                </div>
            ) : (bindingsQuery.data?.bindings.length ?? 0) === 0 ? (
                <div className="px-3 py-3 text-sm text-[var(--app-hint)]">{t('settings.tokens.feishu.empty')}</div>
            ) : (
                bindingsQuery.data?.bindings.map((binding: FeishuEmailBindingSummary) => (
                    <div key={binding.id} className="flex items-center justify-between gap-3 px-3 py-3">
                        <div className="min-w-0 flex-1">
                            <div className="truncate text-sm text-[var(--app-fg)]">{binding.email}</div>
                            <div className="mt-0.5 text-xs leading-snug text-[var(--app-hint)]">
                                {t('settings.tokens.list.namespace')}: <span className="font-mono">{binding.namespace}</span>
                                {' · '}
                                {new Date(binding.createdAt).toLocaleString(locale)}
                            </div>
                        </div>
                        <button
                            type="button"
                            disabled={removeMutation.isPending}
                            onClick={() => removeMutation.mutate(binding.email)}
                            className={dangerButtonClassName}
                        >
                            {t('settings.tokens.feishu.remove')}
                        </button>
                    </div>
                ))
            )}
        </SettingsSection>
    )
}

export default function SettingsTokensPage() {
    const { t } = useTranslation()
    const { api, token, updateAccessToken } = useAppContext()
    const namespace = getNamespaceFromToken(token) ?? ''
    const isOwner = namespace === 'default'

    const feishuConfigQuery = useQuery({
        queryKey: queryKeys.feishuConfig,
        queryFn: () => api!.getFeishuConfig(),
        enabled: Boolean(api)
    })

    return (
        <SettingsPageContent description={t('settings.tokens.description')}>
            <MyTokenSection api={api} namespace={namespace} updateAccessToken={updateAccessToken} />
            {isOwner ? <AdminTokensSection api={api} /> : null}
            {isOwner && feishuConfigQuery.data?.enabled ? <FeishuBindingsSection api={api} /> : null}
        </SettingsPageContent>
    )
}
