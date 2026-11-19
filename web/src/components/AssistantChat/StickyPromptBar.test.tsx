import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationOutlineItem } from '@/chat/outline'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { I18nProvider } from '@/lib/i18n-context'
import { StickyPromptBar, STICKY_PROMPT_BAR_HEIGHT_PX, STICKY_PROMPT_READING_GAP_PX } from './StickyPromptBar'

const ITEMS: ConversationOutlineItem[] = [
    {
        id: 'outline:user-text:m1',
        targetMessageId: 'user-text:m1',
        kind: 'user',
        label: '第一条提问',
        createdAt: Date.parse('2026-11-19T14:02:00')
    },
    {
        id: 'outline:user-text:m2',
        targetMessageId: 'user-text:m2',
        kind: 'user',
        label: '第二条提问',
        createdAt: Date.parse('2026-11-19T14:31:00')
    },
    {
        id: 'outline:user-text:m3',
        targetMessageId: 'user-text:m3',
        kind: 'user',
        label: '第三条提问',
        createdAt: Date.parse('2026-11-19T15:06:00')
    }
]

function rect(top: number, bottom: number): DOMRect {
    return {
        top,
        bottom,
        height: bottom - top,
        left: 0,
        right: 0,
        width: 0,
        x: 0,
        y: top,
        toJSON: () => ({})
    } as DOMRect
}

function setPromptRect(item: ConversationOutlineItem, top: number, bottom: number): void {
    const root = document.getElementById(getConversationMessageAnchorId(item.targetMessageId))
    if (!root) throw new Error(`missing anchor for ${item.id}`)
    const bubble = root.querySelector<HTMLElement>('.happy-user-bubble') ?? root
    const value = rect(top, bottom)
    root.getBoundingClientRect = () => value
    bubble.getBoundingClientRect = () => value
}

function Harness(props: {
    items: readonly ConversationOutlineItem[]
    hidden?: boolean
    onLocate: (item: ConversationOutlineItem) => void
    onNavigate: (item: ConversationOutlineItem) => void
}) {
    const viewportRef = useRef<HTMLDivElement | null>(null)
    const contentRef = useRef<HTMLDivElement | null>(null)

    return (
        <div>
            <div
                ref={(element) => {
                    viewportRef.current = element
                    if (element) {
                        element.getBoundingClientRect = () => rect(0, 600)
                    }
                }}
                data-testid="viewport"
            >
                <div ref={contentRef}>
                    {props.items.map((item) => (
                        <div
                            key={item.id}
                            id={getConversationMessageAnchorId(item.targetMessageId)}
                            data-hapi-message-role="user"
                        >
                            <div className="happy-user-bubble">{item.label}</div>
                        </div>
                    ))}
                    {/* CLI output shares the user role but has no outline item. */}
                    <div id="hapi-message-cli-output:x" data-hapi-message-role="user">
                        <div className="happy-user-bubble">ignored cli output</div>
                    </div>
                </div>
            </div>
            <StickyPromptBar
                viewportRef={viewportRef}
                contentRef={contentRef}
                items={props.items}
                revision={0}
                hidden={props.hidden}
                onLocate={props.onLocate}
                onNavigate={props.onNavigate}
            />
        </div>
    )
}

const READING_LINE = STICKY_PROMPT_BAR_HEIGHT_PX + STICKY_PROMPT_READING_GAP_PX

function mount(props?: { hidden?: boolean }) {
    const onLocate = vi.fn()
    const onNavigate = vi.fn()
    render(
        <I18nProvider>
            <Harness
                items={ITEMS}
                hidden={props?.hidden}
                onLocate={onLocate}
                onNavigate={onNavigate}
            />
        </I18nProvider>
    )
    const bar = screen.getByTestId('sticky-prompt-bar')
    const scroll = () => fireEvent.scroll(screen.getByTestId('viewport'))
    return { bar, scroll, onLocate, onNavigate }
}

async function expectVisible(bar: HTMLElement, visible: boolean) {
    await waitFor(() => {
        expect(bar).toHaveAttribute('data-visible', visible ? 'true' : 'false')
    })
}

describe('StickyPromptBar', () => {
    beforeEach(() => {
        localStorage.setItem('hapi-lang', 'en')
    })

    it('pins the question whose turn sits at the reading line', async () => {
        const { bar, scroll } = mount()
        setPromptRect(ITEMS[0]!, -300, -260)
        setPromptRect(ITEMS[1]!, -120, -80)
        setPromptRect(ITEMS[2]!, 420, 460)
        scroll()

        await expectVisible(bar, true)
        expect(within(bar).getByText('第二条提问')).toBeInTheDocument()
        expect(within(bar).getByText('2 / 3')).toBeInTheDocument()
        expect(within(bar).getByText(/14:31/)).toBeInTheDocument()
    })

    it('stays hidden while the pinned prompt bubble is still visible', async () => {
        const { bar, scroll } = mount()
        setPromptRect(ITEMS[0]!, -300, -260)
        setPromptRect(ITEMS[1]!, -20, READING_LINE + 40)
        setPromptRect(ITEMS[2]!, 420, 460)
        scroll()

        await expectVisible(bar, false)
    })

    it('hides when scrolled above the first prompt', async () => {
        const { bar, scroll } = mount()
        setPromptRect(ITEMS[0]!, 200, 240)
        setPromptRect(ITEMS[1]!, 420, 460)
        setPromptRect(ITEMS[2]!, 620, 660)
        scroll()

        await expectVisible(bar, false)
    })

    it('locates the pinned prompt from the text and the locator button', async () => {
        const { bar, scroll, onLocate } = mount()
        setPromptRect(ITEMS[0]!, -300, -260)
        setPromptRect(ITEMS[1]!, -120, -80)
        setPromptRect(ITEMS[2]!, 420, 460)
        scroll()
        await expectVisible(bar, true)

        fireEvent.click(within(bar).getByText('第二条提问'))
        expect(onLocate).toHaveBeenCalledWith(ITEMS[1])

        const locateButtons = within(bar).getAllByRole('button', { name: 'Jump to this question' })
        fireEvent.click(locateButtons[locateButtons.length - 1]!)
        expect(onLocate).toHaveBeenCalledTimes(2)
    })

    it('steps to the previous and next rendered prompt', async () => {
        const { bar, scroll, onNavigate } = mount()
        setPromptRect(ITEMS[0]!, -300, -260)
        setPromptRect(ITEMS[1]!, -120, -80)
        setPromptRect(ITEMS[2]!, 420, 460)
        scroll()
        await expectVisible(bar, true)

        fireEvent.click(within(bar).getByRole('button', { name: 'Next question' }))
        expect(onNavigate).toHaveBeenLastCalledWith(ITEMS[2])

        fireEvent.click(within(bar).getByRole('button', { name: 'Previous question' }))
        expect(onNavigate).toHaveBeenLastCalledWith(ITEMS[0])
    })

    it('disables stepping past the rendered window edges', async () => {
        const { bar, scroll } = mount()
        setPromptRect(ITEMS[0]!, -300, -260)
        setPromptRect(ITEMS[1]!, 420, 460)
        setPromptRect(ITEMS[2]!, 620, 660)
        scroll()
        await expectVisible(bar, true)

        expect(within(bar).getByRole('button', { name: 'Previous question' })).toBeDisabled()
        expect(within(bar).getByRole('button', { name: 'Next question' })).toBeEnabled()
    })

    it('ignores user-role rows that are not indexed prompts', async () => {
        const { bar, scroll } = mount()
        setPromptRect(ITEMS[0]!, -300, -260)
        setPromptRect(ITEMS[1]!, -120, -80)
        setPromptRect(ITEMS[2]!, 420, 460)
        // The CLI-output row sits above the viewport; it must not become the
        // pinned header or inflate the counter.
        const cli = document.getElementById('hapi-message-cli-output:x')!
        cli.getBoundingClientRect = () => rect(-600, -560)
        scroll()

        await expectVisible(bar, true)
        expect(within(bar).getByText('2 / 3')).toBeInTheDocument()
    })

    it('yields to the search jump when hidden', async () => {
        const { bar, scroll } = mount({ hidden: true })
        setPromptRect(ITEMS[0]!, -300, -260)
        setPromptRect(ITEMS[1]!, -120, -80)
        setPromptRect(ITEMS[2]!, 420, 460)
        scroll()

        await expectVisible(bar, false)
    })
})
