import type { ComponentProps } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HappyAssistantMessage } from './AssistantMessage'

const { messageText, auiState } = vi.hoisted(() => {
    const text = [
        '修复如下：',
        '',
        '```ts',
        'const add = (a: number, b: number) => a + b',
        '```',
        '',
        '完成后运行类型检查。'
    ].join('\n')

    return {
        messageText: text,
        auiState: {
            message: {
                id: 'msg-1',
                role: 'assistant' as const,
                createdAt: new Date(2026, 10, 11, 10, 30),
                content: [
                    { type: 'text' as const, text },
                    { type: 'reasoning' as const, text: '内部推理不应被复制' }
                ],
                metadata: { custom: {} }
            },
            thread: {
                isRunning: false,
                messages: []
            }
        }
    }
})

vi.mock('@assistant-ui/react', () => ({
    MessagePrimitive: {
        Root: ({ children, ...props }: ComponentProps<'div'>) => <div {...props}>{children}</div>,
        Content: () => null
    },
    useAuiState: (selector: (state: typeof auiState) => unknown) => selector(auiState)
}))

vi.mock('@/components/AssistantChat/context', () => ({
    useHappyChatContext: () => ({ metadata: null, disabled: false }),
    useOptionalHappyChatContext: () => ({ showSessionSummaryInChat: false })
}))

vi.mock('@/components/AssistantChat/messages/MessageActions', () => ({
    MessageActions: (props: { align: 'start' | 'end'; copyText?: string }) => (
        <div
            data-testid="message-actions"
            data-align={props.align}
            data-copy-text={props.copyText ?? ''}
            className="happy-message-actions"
        />
    )
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

describe('HappyAssistantMessage copy wiring', () => {
    it('passes the full text, including fenced code, to the hover-revealed copy action', () => {
        const { container } = render(<HappyAssistantMessage />)

        const root = container.querySelector('.happy-message')
        expect(root).not.toBeNull()
        expect(root).toHaveAttribute('data-hapi-message-role', 'assistant')

        const actions = screen.getByTestId('message-actions')
        expect(actions).toHaveClass('happy-message-actions')
        expect(actions).toHaveAttribute('data-align', 'start')
        expect(actions.getAttribute('data-copy-text')).toBe(messageText)
    })
})
