import type { ComponentProps } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HappyAssistantMessage } from './AssistantMessage'

const { auiState, ctx } = vi.hoisted(() => ({
    auiState: {
        message: {
            id: 'msg-1',
            role: 'assistant' as const,
            createdAt: new Date(2026, 10, 11, 10, 30),
            content: [{ type: 'text' as const, text: 'done' }],
            metadata: {
                custom: {
                    kind: 'assistant' as const,
                    localId: 'claude-entry-1'
                }
            }
        },
        thread: {
            isRunning: false,
            messages: []
        }
    },
    ctx: {
        metadata: {
            capabilities: {
                conversationHistory: { forkCurrent: true, forkAtMessage: true }
            }
        },
        disabled: false,
        isLatestCompletedBoundary: (() => false) as () => boolean,
        onForkConversation: vi.fn(async () => {})
    }
}))

vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
        Content: () => null
    },
    useAuiState: (selector: (state: typeof auiState) => unknown) => selector(auiState)
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ctx,
    useOptionalHappyChatContext: () => ({ showSessionSummaryInChat: false })
}))

vi.mock('@/components/AssistantChat/messages/MessageActions', () => ({
    MessageActions: (props: { showFork?: boolean; onFork?: () => Promise<void> }) => props.showFork ? (
        <button type="button" data-testid="fork-action" onClick={() => void props.onFork?.()}>Fork</button>
    ) : null
}))

vi.mock('@/components/AssistantChat/messages/ToolMessage', () => ({
    HappyToolMessage: () => null
}))

vi.mock('@/components/CliOutputBlock', () => ({
    CliOutputBlock: () => null
}))

vi.mock('@/components/AssistantChat/messages/CodexReviewCard', () => ({
    CodexReviewCard: () => null
}))

vi.mock('@/components/AssistantChat/messages/NotifySummaryText', () => ({
    NotifySummaryText: () => null
}))

vi.mock('@/components/assistant-ui/reasoning', () => ({
    Reasoning: () => null,
    ReasoningGroup: () => null
}))

describe('HappyAssistantMessage historical fork', () => {
    it('forks an earlier reply at its own transcript entry', () => {
        ctx.isLatestCompletedBoundary = () => false
        ctx.onForkConversation.mockClear()
        render(<HappyAssistantMessage />)

        fireEvent.click(screen.getByTestId('fork-action'))

        expect(ctx.onForkConversation).toHaveBeenCalledWith('claude-entry-1')
    })

    it('keeps using the tail fork for the latest completed boundary', () => {
        ctx.isLatestCompletedBoundary = () => true
        ctx.onForkConversation.mockClear()
        render(<HappyAssistantMessage />)

        fireEvent.click(screen.getByTestId('fork-action'))

        expect(ctx.onForkConversation).toHaveBeenCalledWith()
    })
})
