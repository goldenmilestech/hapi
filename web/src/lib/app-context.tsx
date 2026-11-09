import { createContext, useContext, type ReactNode } from 'react'
import type { ApiClient } from '@/api/client'
import type { SessionShareInfo } from '@/types/api'

type AppContextValue = {
    api: ApiClient
    token: string
    baseUrl: string
    titleSuggestionAvailable?: boolean
    /**
     * Present while the client is authenticated through a session share link.
     * The shell hides navigation so the visitor only sees that conversation.
     */
    share?: SessionShareInfo | null
}

const AppContext = createContext<AppContextValue | null>(null)

export function AppContextProvider(props: {
    value: AppContextValue
    children: ReactNode
}) {
    return (
        <AppContext.Provider value={props.value}>
            {props.children}
        </AppContext.Provider>
    )
}

export function useAppContext(): AppContextValue {
    const context = useContext(AppContext)
    if (!context) {
        throw new Error('AppContext is not available')
    }
    return context
}

/** For leaf components that also render in isolated tests or tooling. */
export function useOptionalAppContext(): AppContextValue | null {
    return useContext(AppContext)
}
