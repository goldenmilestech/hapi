import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ApiClient } from '@/api/client'
import { getTelegramWebApp, isTelegramEnvironment } from './useTelegram'
import type { AuthSource } from './useAuth'
import {
    consumeFeishuError,
    consumeFeishuState,
    getFeishuCallbackParams,
    storeFeishuError
} from '@/lib/feishuAuth'

const ACCESS_TOKEN_PREFIX = 'hapi_access_token::'
const SHARE_TOKEN_PREFIX = 'hapi_share_token::'

function getTelegramInitData(): string | null {
    const tg = getTelegramWebApp()
    if (tg?.initData) {
        return tg.initData
    }

    // Fallback: check URL parameters (for testing or alternative flows)
    const query = new URLSearchParams(window.location.search)
    const tgWebAppData = query.get('tgWebAppData')
    if (tgWebAppData) {
        return tgWebAppData
    }

    const initData = query.get('initData')
    return initData || null
}

function getTokenFromUrlParams(): string | null {
    if (typeof window === 'undefined') return null
    const query = new URLSearchParams(window.location.search)
    return query.get('token')
}

function getAccessTokenKey(baseUrl: string): string {
    return `${ACCESS_TOKEN_PREFIX}${baseUrl}`
}

function getStoredAccessToken(key: string): string | null {
    try {
        return localStorage.getItem(key)
    } catch {
        return null
    }
}

function storeAccessToken(key: string, token: string): void {
    try {
        localStorage.setItem(key, token)
    } catch {
        // Ignore storage errors
    }
}

function clearStoredAccessToken(key: string): void {
    try {
        localStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

function getShareTokenFromPath(): string | null {
    if (typeof window === 'undefined') return null
    const match = window.location.pathname.match(/^\/s\/([^/]+)\/?$/)
    if (!match?.[1]) return null
    try {
        return decodeURIComponent(match[1])
    } catch {
        return null
    }
}

function getStoredShareToken(key: string): string | null {
    try {
        return sessionStorage.getItem(key)
    } catch {
        return null
    }
}

function storeShareToken(key: string, token: string): void {
    try {
        sessionStorage.setItem(key, token)
    } catch {
        // Ignore storage errors
    }
}

function clearStoredShareToken(key: string): void {
    try {
        sessionStorage.removeItem(key)
    } catch {
        // Ignore storage errors
    }
}

export function useAuthSource(baseUrl: string): {
    authSource: AuthSource | null
    isLoading: boolean
    isTelegram: boolean
    feishuError: string | null
    setAccessToken: (token: string) => void
    clearAuth: () => void
} {
    const [authSource, setAuthSource] = useState<AuthSource | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [isTelegram, setIsTelegram] = useState(false)
    const [feishuError, setFeishuError] = useState<string | null>(null)
    const retryCountRef = useRef(0)
    const feishuCallbackStartedRef = useRef(false)
    const accessTokenKey = useMemo(() => getAccessTokenKey(baseUrl), [baseUrl])
    const shareTokenKey = useMemo(() => `${SHARE_TOKEN_PREFIX}${baseUrl}`, [baseUrl])

    // Initialize auth source on mount, with retry for delayed Telegram initData
    useEffect(() => {
        retryCountRef.current = 0
        setAuthSource(null)
        setIsTelegram(false)
        setIsLoading(true)
        setFeishuError(null)

        // Feishu redirects back to /auth/feishu?code=...&state=... . Exchange
        // the code once, persist the returned personal token, then reload into
        // the app so the normal access-token path takes over.
        const feishuCallback = getFeishuCallbackParams()
        if (feishuCallback) {
            // StrictMode runs effects twice in development; the authorization
            // code is single-use, so only the first pass may exchange it.
            if (feishuCallbackStartedRef.current) {
                return
            }
            feishuCallbackStartedRef.current = true
            if (feishuCallback.error) {
                storeFeishuError(baseUrl, 'login.feishu.denied')
                window.location.replace('/sessions')
                return
            }
            const expectedState = consumeFeishuState(baseUrl)
            if (
                !feishuCallback.code
                || !feishuCallback.state
                || expectedState !== feishuCallback.state
            ) {
                storeFeishuError(baseUrl, 'login.feishu.stateError')
                window.location.replace('/sessions')
                return
            }

            void (async () => {
                try {
                    const client = new ApiClient('', { baseUrl })
                    const auth = await client.authenticate({ feishuCode: feishuCallback.code! })
                    if (!auth.accessToken) {
                        throw new Error('Missing access token')
                    }
                    storeAccessToken(accessTokenKey, auth.accessToken)
                    window.location.replace('/sessions')
                } catch {
                    storeFeishuError(baseUrl, 'login.feishu.exchangeError')
                    window.location.replace('/sessions')
                }
            })()
            return
        }

        // A failed callback reloads with the reason in sessionStorage.
        const pendingFeishuError = consumeFeishuError(baseUrl)
        if (pendingFeishuError) {
            setFeishuError(pendingFeishuError)
        }

        const telegramInitData = getTelegramInitData()

        // A share link is an explicit one-off credential: prefer it over any
        // persisted login so opening the link never leaks the owner's view.
        const pathShareToken = getShareTokenFromPath()
        if (pathShareToken) {
            storeShareToken(shareTokenKey, pathShareToken)
            setAuthSource({ type: 'share', token: pathShareToken })
            setIsLoading(false)
            return
        }

        if (telegramInitData) {
            // Telegram Mini App environment
            setAuthSource({ type: 'telegram', initData: telegramInitData })
            setIsTelegram(true)
            setIsLoading(false)
            return
        }

        // Check for URL token parameter (for direct access links)
        const urlToken = getTokenFromUrlParams()
        if (urlToken) {
            storeAccessToken(accessTokenKey, urlToken) // Save to localStorage for refresh
            setAuthSource({ type: 'accessToken', token: urlToken })
            setIsLoading(false)
            return
        }

        // Check for stored access token as fallback
        const storedToken = getStoredAccessToken(accessTokenKey)
        if (storedToken) {
            setAuthSource({ type: 'accessToken', token: storedToken })
            setIsLoading(false)
            return
        }

        // Refresh on an already-opened share URL: the path no longer carries
        // the token, so keep the tab's share session alive in sessionStorage.
        const storedShareToken = getStoredShareToken(shareTokenKey)
        if (storedShareToken) {
            setAuthSource({ type: 'share', token: storedShareToken })
            setIsLoading(false)
            return
        }

        // Check if we're in a Telegram environment before polling
        if (!isTelegramEnvironment()) {
            // Plain browser - show login prompt immediately
            setIsLoading(false)
            return
        }

        // Telegram environment detected - poll for delayed initData
        // Telegram WebApp SDK may initialize slightly after page mount
        const maxRetries = 20
        const retryInterval = 250 // ms

        const interval = setInterval(() => {
            retryCountRef.current += 1
            const initData = getTelegramInitData()

            if (initData) {
                setAuthSource({ type: 'telegram', initData })
                setIsTelegram(true)
                setIsLoading(false)
                clearInterval(interval)
            } else if (retryCountRef.current >= maxRetries) {
                // Give up - show login prompt for browser access
                setIsLoading(false)
                clearInterval(interval)
            }
        }, retryInterval)

        return () => {
            clearInterval(interval)
        }
    }, [accessTokenKey, shareTokenKey])

    const setAccessToken = useCallback((token: string) => {
        storeAccessToken(accessTokenKey, token)
        clearStoredShareToken(shareTokenKey)
        setAuthSource({ type: 'accessToken', token })
    }, [accessTokenKey, shareTokenKey])

    const clearAuth = useCallback(() => {
        clearStoredAccessToken(accessTokenKey)
        clearStoredShareToken(shareTokenKey)
        setAuthSource(null)
    }, [accessTokenKey, shareTokenKey])

    return {
        authSource,
        isLoading,
        isTelegram,
        feishuError,
        setAccessToken,
        clearAuth
    }
}
