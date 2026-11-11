import { readFileSync } from 'node:fs'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider } from '@/lib/i18n-context'
import { safeCopyToClipboard } from '@/lib/clipboard'
import { MessageActions } from './MessageActions'

const { auiState } = vi.hoisted(() => ({
    auiState: {
        message: {
            id: 'msg-1',
            createdAt: new Date(2026, 10, 11, 10, 30)
        },
        thread: {
            isRunning: false,
            messages: []
        }
    }
}))

vi.mock('@assistant-ui/react', () => ({
    useAuiState: (selector: (state: typeof auiState) => unknown) => selector(auiState)
}))

vi.mock('@/lib/clipboard', () => ({
    safeCopyToClipboard: vi.fn(async () => {})
}))

vi.mock('@/components/ui/ConfirmDialog', () => ({
    ConfirmDialog: () => null
}))

const ASSISTANT_TEXT = [
    '修复如下：',
    '',
    '```ts',
    'const add = (a: number, b: number) => a + b',
    '```',
    '',
    '完成后运行类型检查。'
].join('\n')

function renderCopyAction(copyText = ASSISTANT_TEXT) {
    return render(
        <I18nProvider>
            <MessageActions align="start" copyText={copyText} />
        </I18nProvider>
    )
}

describe('assistant message copy action', () => {
    beforeEach(() => {
        window.localStorage.clear()
        vi.clearAllMocks()
    })

    it('writes the full assistant text, including fenced code, to the clipboard', async () => {
        renderCopyAction()

        fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

        await waitFor(() => {
            expect(safeCopyToClipboard).toHaveBeenCalledWith(ASSISTANT_TEXT)
        })
        const copiedButton = await screen.findByRole('button', { name: 'Copied' })
        expect(copiedButton.querySelector('svg')).toHaveClass('text-green-500')
    })

    it('keeps the copy action on the hover-revealed row used by assistant messages', () => {
        const { container } = renderCopyAction()

        const row = container.querySelector('.happy-message-actions')
        expect(row).not.toBeNull()
        expect(row!.querySelector('button[aria-label="Copy"]')).not.toBeNull()

        // jsdom cannot evaluate `:hover` or the fine-pointer media query, so
        // assert the stylesheet contract that hides the row by default and
        // reveals it only while the `.happy-message` shell is hovered/focused.
        const css = readFileSync('src/index.css', 'utf8')
        const hoverBlock = [...css.matchAll(/@media \(hover: hover\) and \(pointer: fine\) \{([\s\S]*?)\n\}/g)]
            .map((match) => match[1] ?? '')
            .find((block) => block.includes('.happy-message-actions')) ?? ''

        expect(hoverBlock).not.toBe('')
        expect(hoverBlock).toMatch(/\.happy-message-actions \{[^}]*opacity: 0;[^}]*pointer-events: none;/)
        expect(hoverBlock).toMatch(
            /\.happy-message:hover \.happy-message-actions,[^}]*\.happy-message:focus-within \.happy-message-actions \{[^}]*opacity: 1;[^}]*pointer-events: auto;/
        )
    })
})
