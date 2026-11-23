import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConversationOutlineItem } from '@/chat/outline'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { I18nProvider } from '@/lib/i18n-context'
import {
    StickyPromptBar,
    STICKY_PROMPT_BAR_HEIGHT_PX,
    STICKY_PROMPT_READING_GAP_PX,
    type StickyPromptStep
} from './StickyPromptBar'

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

const EXTENDED_ITEMS: ConversationOutlineItem[] = [
    ...ITEMS,
    {
        id: 'outline:user-text:m4',
        targetMessageId: 'user-text:m4',
        kind: 'user',
        label: '第四条提问',
        createdAt: Date.parse('2026-11-19T15:22:00')
    },
    {
        id: 'outline:user-text:m5',
        targetMessageId: 'user-text:m5',
        kind: 'user',
        label: '第五条提问',
        createdAt: Date.parse('2026-11-19T15:40:00')
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
    /** Rendered message window; defaults to every indexed prompt. */
    renderItems?: readonly ConversationOutlineItem[]
    hidden?: boolean
    onLocate: (item: ConversationOutlineItem) => void
    onStep: (direction: -1 | 1, current: StickyPromptStep) => void
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
                    {(props.renderItems ?? props.items).map((item) => (
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
                onStep={props.onStep}
            />
        </div>
    )
}

const READING_LINE = STICKY_PROMPT_BAR_HEIGHT_PX + STICKY_PROMPT_READING_GAP_PX

function mount(props?: {
    hidden?: boolean
    items?: readonly ConversationOutlineItem[]
    renderItems?: readonly ConversationOutlineItem[]
}) {
    const onLocate = vi.fn()
    const onStep = vi.fn()
    render(
        <I18nProvider>
            <Harness
                items={props?.items ?? ITEMS}
                renderItems={props?.renderItems}
                hidden={props?.hidden}
                onLocate={onLocate}
                onStep={onStep}
            />
        </I18nProvider>
    )
    const bar = screen.getByTestId('sticky-prompt-bar')
    const scroll = () => fireEvent.scroll(screen.getByTestId('viewport'))
    return { bar, scroll, onLocate, onStep }
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

    it('shows the previous message while the turn under the line is still visible', async () => {
        // The reader is looking at the second question itself. The bar stands
        // for the last message scrolled past, so it shows the first one; the
        // step base stays on the visible turn so the up arrow lands on what
        // the bar shows and down moves to the third.
        const { bar, scroll, onStep } = mount()
        setPromptRect(ITEMS[0]!, -300, -260)
        setPromptRect(ITEMS[1]!, -20, READING_LINE + 40)
        setPromptRect(ITEMS[2]!, 420, 460)
        scroll()

        await expectVisible(bar, true)
        expect(within(bar).getByText('第一条提问')).toBeInTheDocument()
        expect(within(bar).getByText('1 / 3')).toBeInTheDocument()

        fireEvent.click(within(bar).getByRole('button', { name: 'Previous question' }))
        expect(onStep).toHaveBeenLastCalledWith(-1, { item: ITEMS[1], position: 2 })
        fireEvent.click(within(bar).getByRole('button', { name: 'Next question' }))
        expect(onStep).toHaveBeenLastCalledWith(1, { item: ITEMS[1], position: 2 })
    })

    it('hides when the first prompt itself is visible at the line', async () => {
        // Nothing has scrolled past the top edge yet, so there is no previous
        // message for the bar to stand for.
        const { bar, scroll } = mount()
        setPromptRect(ITEMS[0]!, -20, READING_LINE + 40)
        setPromptRect(ITEMS[1]!, 420, 460)
        setPromptRect(ITEMS[2]!, 620, 660)
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

    it('reports the step direction and the pinned turn', async () => {
        const { bar, scroll, onStep } = mount()
        setPromptRect(ITEMS[0]!, -300, -260)
        setPromptRect(ITEMS[1]!, -120, -80)
        setPromptRect(ITEMS[2]!, 420, 460)
        scroll()
        await expectVisible(bar, true)

        fireEvent.click(within(bar).getByRole('button', { name: 'Next question' }))
        expect(onStep).toHaveBeenLastCalledWith(1, { item: ITEMS[1], position: 2 })

        fireEvent.click(within(bar).getByRole('button', { name: 'Previous question' }))
        expect(onStep).toHaveBeenLastCalledWith(-1, { item: ITEMS[1], position: 2 })
    })

    it('keeps stepping enabled into a prompt outside the rendered window', async () => {
        // The loaded window only holds the last three prompts; the first two
        // are still lazy and only exist in the session-wide outline index.
        // The bar cannot see them, but stepping stays enabled so the thread
        // can resolve and load the next turn.
        const rendered = EXTENDED_ITEMS.slice(2)
        const { bar, scroll, onStep } = mount({ items: EXTENDED_ITEMS, renderItems: rendered })
        setPromptRect(EXTENDED_ITEMS[2]!, -300, -260)
        setPromptRect(EXTENDED_ITEMS[3]!, 320, 360)
        setPromptRect(EXTENDED_ITEMS[4]!, 620, 660)
        scroll()
        await expectVisible(bar, true)

        expect(within(bar).getByText('3 / 5')).toBeInTheDocument()
        const previous = within(bar).getByRole('button', { name: 'Previous question' })
        expect(previous).toBeEnabled()
        fireEvent.click(previous)
        expect(onStep).toHaveBeenCalledWith(-1, { item: EXTENDED_ITEMS[2], position: 3 })
    })

    it('keeps a bar for the previous prompt when the window starts mid-answer', async () => {
        // The window begins inside prompt 2's answer: prompts 3-5 render, but
        // their tops are all below the reading line. The bar must still say
        // which turn the visible content belongs to and offer to load it.
        const rendered = EXTENDED_ITEMS.slice(2)
        const { bar, scroll, onLocate, onStep } = mount({ items: EXTENDED_ITEMS, renderItems: rendered })
        setPromptRect(EXTENDED_ITEMS[2]!, 320, 360)
        setPromptRect(EXTENDED_ITEMS[3]!, 620, 660)
        setPromptRect(EXTENDED_ITEMS[4]!, 920, 960)
        scroll()

        await expectVisible(bar, true)
        expect(within(bar).getByText('第二条提问')).toBeInTheDocument()
        expect(within(bar).getByText('2 / 5')).toBeInTheDocument()

        fireEvent.click(within(bar).getByRole('button', { name: 'Previous question' }))
        expect(onStep).toHaveBeenLastCalledWith(-1, { item: EXTENDED_ITEMS[1], position: 2 })
        fireEvent.click(within(bar).getByRole('button', { name: 'Next question' }))
        expect(onStep).toHaveBeenLastCalledWith(1, { item: EXTENDED_ITEMS[1], position: 2 })

        const locateButtons = within(bar).getAllByRole('button', { name: 'Jump to this question' })
        fireEvent.click(locateButtons[0]!)
        expect(onLocate).toHaveBeenCalledWith(EXTENDED_ITEMS[1])
    })

    it('disables stepping past the session outline edges', async () => {
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
