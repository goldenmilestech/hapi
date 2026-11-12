import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { ApiError } from '@/api/client'
import type { AccessTokenSummary } from '@/types/api'
import SettingsTokensPage from '@/routes/settings/tokens'

const getAccessTokensMock = vi.fn()
const createAccessTokenMock = vi.fn()
const revokeAccessTokenMock = vi.fn()
const getAccessTokenByIdMock = vi.fn()
const getPersonalAccessTokenMock = vi.fn()
const createPersonalAccessTokenMock = vi.fn()
const regeneratePersonalAccessTokenMock = vi.fn()
const getFeishuConfigMock = vi.fn()
const getFeishuBindingsMock = vi.fn()
const addFeishuBindingMock = vi.fn()
const removeFeishuBindingMock = vi.fn()
const updateAccessTokenMock = vi.fn()

let namespace = 'default'

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: {
            getAccessTokens: getAccessTokensMock,
            createAccessToken: createAccessTokenMock,
            revokeAccessToken: revokeAccessTokenMock,
            getAccessTokenById: getAccessTokenByIdMock,
            getPersonalAccessToken: getPersonalAccessTokenMock,
            createPersonalAccessToken: createPersonalAccessTokenMock,
            regeneratePersonalAccessToken: regeneratePersonalAccessTokenMock,
            getFeishuConfig: getFeishuConfigMock,
            getFeishuBindings: getFeishuBindingsMock,
            addFeishuBinding: addFeishuBindingMock,
            removeFeishuBinding: removeFeishuBindingMock
        },
        token: makeJwt(),
        updateAccessToken: updateAccessTokenMock
    })
}))

function makeJwt(ns = namespace): string {
    const payload = btoa(JSON.stringify({ ns })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
    return `e30.${payload}.sig`
}

function makeToken(overrides: Partial<AccessTokenSummary> = {}): AccessTokenSummary {
    return {
        id: 'token-1',
        name: 'Alice laptop',
        namespace: 'alice',
        tokenPrefix: 'hapi_abcdefg',
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
        ...overrides
    }
}

function renderPage() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <SettingsTokensPage />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('SettingsTokensPage', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        namespace = 'default'
        getAccessTokensMock.mockResolvedValue({ tokens: [] })
        getPersonalAccessTokenMock.mockResolvedValue({ token: 'hapi_personal-token', tokenInfo: makeToken() })
        getFeishuConfigMock.mockResolvedValue({
            enabled: false,
            appId: null,
            redirectUri: null,
            scope: '',
            authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
        })
        getFeishuBindingsMock.mockResolvedValue({ bindings: [] })
    })

    afterEach(() => {
        cleanup()
    })

    it('shows the caller namespace and personal token', async () => {
        renderPage()

        expect(await screen.findByText('hapi_personal-token')).toBeTruthy()
        expect(screen.getByText(/Namespace:/)).toBeTruthy()
    })

    it('creates a personal token when none exists and updates the stored credential', async () => {
        getPersonalAccessTokenMock.mockResolvedValue({ token: null, tokenInfo: null })
        createPersonalAccessTokenMock.mockResolvedValue({
            token: 'hapi_new-personal',
            tokenInfo: makeToken({ id: 'token-2' })
        })
        renderPage()

        fireEvent.click(await screen.findByRole('button', { name: 'Create my access token' }))

        await waitFor(() => expect(createPersonalAccessTokenMock).toHaveBeenCalled())
        await waitFor(() => expect(updateAccessTokenMock).toHaveBeenCalledWith('hapi_new-personal'))
    })

    it('lists issued tokens for the owner', async () => {
        getAccessTokensMock.mockResolvedValue({ tokens: [makeToken()] })
        renderPage()

        expect(await screen.findByText('Alice laptop')).toBeTruthy()
        expect(screen.getByText(/Namespace: alice/)).toBeTruthy()
        expect(screen.queryByText('Feishu bindings')).toBeNull()
    })

    it('hides owner-only sections for other namespaces', async () => {
        namespace = 'alice'
        renderPage()

        expect(await screen.findByText('hapi_personal-token')).toBeTruthy()
        expect(screen.queryByText('Issue a token')).toBeNull()
        expect(screen.queryByText('Issued tokens')).toBeNull()
    })

    it('shows a newly created token once and clears the form', async () => {
        createAccessTokenMock.mockResolvedValue({
            token: 'hapi_new-token-value',
            tokenInfo: makeToken({ id: 'token-2' })
        })
        renderPage()

        fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Alice laptop' } })
        fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'alice' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create token' }))

        expect(await screen.findByText('hapi_new-token-value')).toBeTruthy()
        expect(createAccessTokenMock).toHaveBeenCalledWith({ name: 'Alice laptop', namespace: 'alice' })
        expect((screen.getByLabelText('Label') as HTMLInputElement).value).toBe('')
    })

    it('reports a namespace conflict instead of a generic failure', async () => {
        createAccessTokenMock.mockRejectedValue(new ApiError('HTTP 409', 409, undefined, '{"error":"Namespace already bound"}'))
        renderPage()

        fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Alice phone' } })
        fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'alice' } })
        fireEvent.click(screen.getByRole('button', { name: 'Create token' }))

        expect(await screen.findByText(/already has an active token/i)).toBeTruthy()
    })

    it('asks for confirmation before revoking a token', async () => {
        getAccessTokensMock.mockResolvedValue({ tokens: [makeToken()] })
        revokeAccessTokenMock.mockResolvedValue(undefined)
        renderPage()

        fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }))
        expect(revokeAccessTokenMock).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole('button', { name: 'Confirm revoke' }))
        await waitFor(() => expect(revokeAccessTokenMock).toHaveBeenCalledWith('token-1'))
    })

    it('manages Feishu bindings when Feishu is enabled', async () => {
        getFeishuConfigMock.mockResolvedValue({
            enabled: true,
            appId: 'cli_test',
            redirectUri: 'https://hub/auth/feishu',
            scope: 'contact:user.email:readonly',
            authorizeUrl: 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
        })
        getFeishuBindingsMock.mockResolvedValue({
            bindings: [{ id: 'binding-1', email: 'alice@corp.com', namespace: 'legacy-alice', createdAt: 1 }]
        })
        addFeishuBindingMock.mockResolvedValue({
            binding: { id: 'binding-2', email: 'bob@corp.com', namespace: 'bob', createdAt: 2 }
        })
        renderPage()

        expect(await screen.findByText('alice@corp.com')).toBeTruthy()

        fireEvent.change(screen.getByLabelText('Feishu email'), { target: { value: 'bob@corp.com' } })
        fireEvent.change(screen.getByLabelText('Binding namespace'), { target: { value: 'bob' } })
        fireEvent.click(screen.getByRole('button', { name: 'Add binding' }))

        await waitFor(() => expect(addFeishuBindingMock).toHaveBeenCalledWith({
            email: 'bob@corp.com',
            namespace: 'bob'
        }))
    })
})
