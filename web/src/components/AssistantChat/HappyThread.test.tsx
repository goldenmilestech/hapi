import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useState, type ComponentProps } from 'react'
import { I18nProvider } from '@/lib/i18n-context'
import {
    ConversationOutlinePanel,
    anchorMessageIdFromAnchor,
    captureScrollAnchor,
    captureTopVisibleDescendant,
    computeHistoryAnchorCorrection,
    getHistoryCoverageRetryDelay,
    getPullToLoadState,
    getScrollIntent,
    getScrollToBottomButtonVisibility,
    getStickyPromptParkDelta,
    hasAppliedHistoryVersion,
    isNestedScrollEvent,
    focusOutlineTargetMessage,
    locateOutlineTargetMessage,
    prependMissingUserSnapshot,
    resolveStickyStepTarget,
    restoreScrollAnchor,
    resolveHistoryAnchorElement,
    revealStepTarget,
    shouldLoadOlderForViewport,
    shouldCancelInitialScrollSettling,
    shouldPreserveHistoryScrollAnchor,
    shouldRenderScrollToBottomButton,
    shouldShowScrollToBottomButton,
    ThreadMessagesById,
} from '@/components/AssistantChat/HappyThread'
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import type { ConversationOutlineItem } from '@/chat/outline'

const outlineItems: ConversationOutlineItem[] = [
    {
        id: 'outline:user-text:m1',
        targetMessageId: 'user-text:m1',
        kind: 'user',
        label: 'Implement the panel',
        createdAt: 1000
    },
    {
        id: 'outline:user-text:m2',
        targetMessageId: 'user-text:m2',
        kind: 'user',
        label: 'Second user prompt',
        createdAt: 2000
    }
]

describe('nested scroll event ownership', () => {
    it('recognizes events from a nested scroll viewport and its descendants', () => {
        const nested = document.createElement('div')
        nested.dataset.hapiNestedScroll = 'true'
        const child = document.createElement('span')
        child.textContent = 'reasoning'
        nested.append(child)
        document.body.append(nested)

        const nestedEvent = new Event('wheel')
        Object.defineProperty(nestedEvent, 'target', { value: nested })
        const childEvent = new Event('keydown')
        Object.defineProperty(childEvent, 'target', { value: child })

        expect(isNestedScrollEvent(new WheelEvent('wheel'))).toBe(false)
        expect(isNestedScrollEvent(nestedEvent)).toBe(true)
        expect(isNestedScrollEvent(childEvent)).toBe(true)

        nested.remove()
    })
})

describe('ThreadMessagesById', () => {
    it('does not crash when rewind shortens the transcript and then clears it', async () => {
        type TestMessage = { id: string; role: 'user' | 'assistant'; text: string }
        let setMessages!: (messages: TestMessage[]) => void
        function Harness() {
            const [messages, updateMessages] = useState<TestMessage[]>([
                { id: 'user-1', role: 'user', text: 'first' },
                { id: 'assistant-1', role: 'assistant', text: 'answer' },
                { id: 'user-2', role: 'user', text: 'second' },
                { id: 'assistant-2', role: 'assistant', text: 'second answer' }
            ])
            setMessages = updateMessages
            const runtime = useExternalStoreRuntime({
                messages,
                convertMessage: (message): ThreadMessageLike => ({
                    id: message.id,
                    role: message.role,
                    content: [{ type: 'text', text: message.text }]
                }),
                onNew: async () => {}
            })
            return (
                <AssistantRuntimeProvider runtime={runtime}>
                    <ThreadMessagesById components={{
                        UserMessage: () => <div data-testid="user-message" />,
                        AssistantMessage: () => <div data-testid="assistant-message" />,
                        SystemMessage: () => <div data-testid="system-message" />
                    }} />
                </AssistantRuntimeProvider>
            )
        }

        render(<Harness />)
        expect(screen.getAllByTestId('user-message')).toHaveLength(2)
        expect(screen.getAllByTestId('assistant-message')).toHaveLength(2)

        await act(async () => {
            setMessages([
                { id: 'user-1', role: 'user', text: 'first' },
                { id: 'assistant-1', role: 'assistant', text: 'answer' }
            ])
        })

        await waitFor(() => {
            expect(screen.getAllByTestId('user-message')).toHaveLength(1)
            expect(screen.getAllByTestId('assistant-message')).toHaveLength(1)
        })

        await act(async () => {
            setMessages([])
        })

        await waitFor(() => {
            expect(screen.queryByTestId('user-message')).not.toBeInTheDocument()
            expect(screen.queryByTestId('assistant-message')).not.toBeInTheDocument()
        })
    })
})

function rect(values: Pick<DOMRect, 'top' | 'bottom'> & Partial<DOMRect>): DOMRect {
    return {
        left: 0,
        right: 300,
        width: 300,
        height: values.bottom - values.top,
        x: 0,
        y: values.top,
        toJSON: () => ({}),
        ...values
    } as DOMRect
}

function renderPanel(props: Partial<ComponentProps<typeof ConversationOutlinePanel>> = {}) {
    return render(
        <I18nProvider>
            <ConversationOutlinePanel
                items={outlineItems}
                isLoadingItems={false}
                hasMoreMessages={false}
                isLoadingMoreMessages={false}
                onLoadMore={vi.fn()}
                onSelect={vi.fn()}
                onClose={vi.fn()}
                {...props}
            />
        </I18nProvider>
    )
}

describe('ConversationOutlinePanel', () => {
    it('renders outline items and selects an item', () => {
        const onSelect = vi.fn()
        renderPanel({ onSelect })

        fireEvent.click(screen.getByText('Implement the panel'))

        expect(onSelect).toHaveBeenCalledWith(outlineItems[0])
    })

    it('shows each message time instead of a redundant user label', () => {
        const { container } = renderPanel()

        const timestamps = container.querySelectorAll('time')
        expect(timestamps).toHaveLength(outlineItems.length)
        expect(timestamps[0]).toHaveAttribute('dateTime', new Date(outlineItems[0].createdAt).toISOString())
        expect(timestamps[0]).toHaveAttribute('title')
        expect(screen.queryByText('User')).not.toBeInTheDocument()
    })

    it('shows load earlier when older messages exist', () => {
        const onLoadMore = vi.fn()
        renderPanel({ hasMoreMessages: true, onLoadMore })

        fireEvent.click(screen.getByRole('button', { name: /Load earlier/ }))

        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('shows a loading state instead of the partial window list while the full index loads', () => {
        renderPanel({ isLoadingItems: true, hasMoreMessages: true })

        expect(screen.getByRole('status')).toHaveTextContent('Loading the full outline')
        expect(screen.queryByText('Implement the panel')).not.toBeInTheDocument()
        expect(screen.queryByRole('button', { name: /Load earlier/ })).not.toBeInTheDocument()
    })

    it('uses a concise placeholder for outline search', () => {
        renderPanel()

        expect(screen.getByPlaceholderText('Search outline')).toBeInTheDocument()
    })

    it('filters loaded outline items without hiding load earlier', () => {
        const onLoadMore = vi.fn()
        renderPanel({ hasMoreMessages: true, onLoadMore })

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search outline items' }), {
            target: { value: 'SECOND' }
        })

        expect(screen.queryByText('Implement the panel')).not.toBeInTheDocument()
        expect(screen.getByText('Second user prompt')).toBeInTheDocument()
        expect(screen.getByText('1 of 2 items')).toBeInTheDocument()
        fireEvent.click(screen.getByRole('button', { name: /Load earlier/ }))
        expect(onLoadMore).toHaveBeenCalledTimes(1)
    })

    it('supports wildcard patterns in outline search', () => {
        renderPanel()

        const searchbox = screen.getByRole('searchbox', { name: 'Search outline items' })
        fireEvent.change(searchbox, { target: { value: 'Implement*' } })

        expect(screen.getByText('Implement the panel')).toBeInTheDocument()
        expect(screen.queryByText('Second user prompt')).not.toBeInTheDocument()

        fireEvent.change(searchbox, { target: { value: 'Second user p?????' } })

        expect(screen.queryByText('Implement the panel')).not.toBeInTheDocument()
        expect(screen.getByText('Second user prompt')).toBeInTheDocument()
    })

    it('lets the shared matcher normalize outline queries consistently', () => {
        const toLocaleLowerCase = vi.spyOn(String.prototype, 'toLocaleLowerCase').mockImplementation(function (this: string) {
            return this.toString() === 'I' ? 'ı' : this.toLowerCase()
        })
        try {
            renderPanel({
                items: [
                    ...outlineItems,
                    {
                        id: 'outline:user-text:m3',
                        targetMessageId: 'user-text:m3',
                        kind: 'user',
                        label: 'Istanbul deployment',
                        createdAt: 3000
                    }
                ]
            })
            fireEvent.change(screen.getByRole('searchbox', { name: 'Search outline items' }), {
                target: { value: 'I' }
            })

            expect(screen.getByText('Istanbul deployment')).toBeInTheDocument()
        } finally {
            toLocaleLowerCase.mockRestore()
        }
    })

    it('shows a search-specific empty state', () => {
        renderPanel()

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search outline items' }), {
            target: { value: 'missing' }
        })

        expect(screen.getByText('No matching outline items')).toBeInTheDocument()
        expect(screen.queryByText('No outline items in loaded messages')).not.toBeInTheDocument()
    })

    it('keeps an in-panel close action available', () => {
        const onClose = vi.fn()
        renderPanel({ onClose })

        const closeButton = screen.getByRole('button', { name: 'Close' })
        expect(closeButton).toHaveClass('border', 'rounded-md', 'h-9', 'w-9')
        fireEvent.click(closeButton)

        expect(onClose).toHaveBeenCalledTimes(1)
    })

    it('renders an empty state', () => {
        renderPanel({ items: [] })

        expect(screen.getByText('No outline items in loaded messages')).toBeInTheDocument()
    })
})

describe('scroll anchor helpers', () => {
    it('captures the first visible message relative to the viewport', () => {
        const viewport = document.createElement('div')
        const first = document.createElement('div')
        const second = document.createElement('div')
        first.id = 'first-message'
        second.id = 'second-message'
        viewport.className = 'viewport'
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        messages.append(first, second)
        viewport.append(messages)
        document.body.append(viewport)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(first, 'getBoundingClientRect').mockReturnValue(rect({ top: 60, bottom: 90 }))
        vi.spyOn(second, 'getBoundingClientRect').mockReturnValue(rect({ top: 120, bottom: 180 }))

        expect(captureScrollAnchor(viewport)).toEqual({
            id: 'second-message',
            topOffset: 20
        })

        viewport.remove()
    })

    it('treats upward motion near the bottom as manual scroll intent', () => {
        expect(getScrollIntent({
            scrollTop: 690,
            previousScrollTop: 702,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 12,
            isNearBottom: false,
            isScrollingUp: true
        })
    })

    it('does not resume tail-following merely because downward reading is close to the bottom', () => {
        expect(getScrollIntent({
            scrollTop: 610,
            previousScrollTop: 590,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 92,
            isNearBottom: false,
            isScrollingUp: false
        })
    })

    it('does not classify downward movement as upward manual scroll intent', () => {
        expect(getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 690,
            scrollHeight: 1232,
            clientHeight: 530
        })).toMatchObject({
            distanceFromBottom: 0,
            isNearBottom: true,
            isScrollingUp: false
        })
    })

    it('shows the jump button in either direction away from the bottom', () => {
        const downward = getScrollIntent({
            scrollTop: 610,
            previousScrollTop: 590,
            scrollHeight: 1232,
            clientHeight: 530
        })
        const upward = getScrollIntent({
            scrollTop: 590,
            previousScrollTop: 610,
            scrollHeight: 1232,
            clientHeight: 530
        })
        const atBottom = getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 690,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(downward.isScrollingDown).toBe(true)
        expect(shouldShowScrollToBottomButton(downward)).toBe(true)
        expect(shouldShowScrollToBottomButton(upward)).toBe(true)
        expect(shouldShowScrollToBottomButton(atBottom)).toBe(false)
    })

    it('keeps the jump button hidden while the new-message indicator has content', () => {
        expect(shouldRenderScrollToBottomButton(true, 0)).toBe(true)
        expect(shouldRenderScrollToBottomButton(true, 1)).toBe(false)
        expect(shouldRenderScrollToBottomButton(false, 0)).toBe(false)
    })

    it('keeps the jump button visible when scrolling stops or reverses', () => {
        const downward = getScrollIntent({
            scrollTop: 610,
            previousScrollTop: 590,
            scrollHeight: 1232,
            clientHeight: 530
        })
        const stationary = getScrollIntent({
            scrollTop: 610,
            previousScrollTop: 610,
            scrollHeight: 1232,
            clientHeight: 530
        })
        const upward = getScrollIntent({
            scrollTop: 590,
            previousScrollTop: 610,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(getScrollToBottomButtonVisibility(false, downward)).toBe(true)
        expect(getScrollToBottomButtonVisibility(true, stationary)).toBe(true)
        expect(getScrollToBottomButtonVisibility(true, upward)).toBe(true)
    })

    it('cancels initial scroll settling when the user scrolls up away from the bottom', () => {
        const intent = getScrollIntent({
            scrollTop: 520,
            previousScrollTop: 700,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(intent).toMatchObject({
            distanceFromBottom: 182,
            isScrollingUp: true
        })
        expect(shouldCancelInitialScrollSettling(intent, true)).toBe(true)
    })

    it('keeps initial scroll settling for programmatic upward movement', () => {
        const intent = getScrollIntent({
            scrollTop: 0,
            previousScrollTop: 700,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(shouldCancelInitialScrollSettling(intent, false)).toBe(false)
    })

    it('keeps initial scroll settling for negligible movement at the bottom', () => {
        const intent = getScrollIntent({
            scrollTop: 702,
            previousScrollTop: 702,
            scrollHeight: 1232,
            clientHeight: 530
        })

        expect(intent).toMatchObject({
            distanceFromBottom: 0,
            isScrollingUp: false
        })
        expect(shouldCancelInitialScrollSettling(intent, false)).toBe(false)
    })

    it('re-applies the history anchor while the reader owns the viewport', () => {
        expect(shouldPreserveHistoryScrollAnchor({
            hasAnchor: true,
            autoScrollEnabled: false,
            searchTargetLocked: false,
            pendingScrollRestore: false,
            tailScrollInProgress: false,
            initialScrollSettling: false,
            outlineJumpInProgress: false
        })).toBe(true)
    })

    it('computes the history correction from the baseline plus the scroll delta', () => {
        // Scrolled up 300px, no layout change: the row sits exactly where the
        // scroll moved it, so there is nothing to correct.
        expect(computeHistoryAnchorCorrection({
            anchorTopOffset: 10,
            baselineScrollTop: 1000,
            currentScrollTop: 700,
            currentAnchorOffset: 310
        })).toBe(0)

        // A card above the viewport collapsed by 172px in the same frame as
        // that scroll. The correction scrolls the viewport up by the shrink
        // (negative), restoring the row before paint.
        expect(computeHistoryAnchorCorrection({
            anchorTopOffset: 10,
            baselineScrollTop: 1000,
            currentScrollTop: 700,
            currentAnchorOffset: 310 - 172
        })).toBe(-172)

        // A resize without any scroll keeps the baseline offset.
        expect(computeHistoryAnchorCorrection({
            anchorTopOffset: 10,
            baselineScrollTop: 1000,
            currentScrollTop: 1000,
            currentAnchorOffset: -1204
        })).toBe(-1214)
    })

    it('finds the first visible row in a long list', () => {
        const viewport = document.createElement('div')
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        viewport.className = 'viewport'
        viewport.append(messages)
        document.body.append(viewport)

        const rows = Array.from({ length: 6 }, (_, index) => {
            const row = document.createElement('div')
            row.id = `row-${index}`
            messages.append(row)
            return row
        })

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        const tops = [0, 40, 90, 140, 200, 260]
        rows.forEach((row, index) => {
            const top = tops[index]!
            vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect({ top, bottom: top + 40 }))
        })

        expect(captureScrollAnchor(viewport)).toEqual({
            id: 'row-2',
            topOffset: -10
        })

        viewport.remove()
    })

    it('anchors on the topmost visible block inside a row taller than the viewport', () => {
        const viewport = document.createElement('div')
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        viewport.append(messages)
        document.body.append(viewport)

        const row = document.createElement('div')
        row.id = 'hapi-message-agent-reasoning:turn-1'
        messages.append(row)

        // The row spans several screenfuls. One block sits entirely above the
        // viewport top; the next one crosses it and holds the visible text.
        const above = document.createElement('div')
        const crossing = document.createElement('div')
        const text = document.createElement('p')
        crossing.append(text)
        row.append(above, crossing)

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect({ top: -500, bottom: 1400 }))
        vi.spyOn(above, 'getBoundingClientRect').mockReturnValue(rect({ top: -500, bottom: 60 }))
        vi.spyOn(crossing, 'getBoundingClientRect').mockReturnValue(rect({ top: 60, bottom: 600 }))
        vi.spyOn(text, 'getBoundingClientRect').mockReturnValue(rect({ top: 70, bottom: 120 }))

        // A row-level anchor would report the row top and miss every resize
        // that happens inside it above the viewport.
        expect(captureTopVisibleDescendant(viewport, row, 100)).toBe(text)

        // Sticky boxes do not move with their parent, so they cannot anchor.
        text.style.position = 'sticky'
        expect(captureTopVisibleDescendant(viewport, row, 100)).toBe(crossing)

        // A row whose top is already the topmost visible block stays the
        // anchor when no child crosses the viewport top.
        vi.spyOn(above, 'getBoundingClientRect').mockReturnValue(rect({ top: 120, bottom: 180 }))
        vi.spyOn(crossing, 'getBoundingClientRect').mockReturnValue(rect({ top: 180, bottom: 600 }))
        expect(captureTopVisibleDescendant(viewport, row, 100)).toBe(row)

        viewport.remove()
    })

    it('recovers a re-keyed anchor through its source message id', () => {
        const viewport = document.createElement('div')
        const messages = document.createElement('div')
        messages.className = 'happy-thread-messages'
        viewport.append(messages)
        document.body.append(viewport)

        const original = document.createElement('div')
        original.id = 'hapi-message-tool-call:msg-1'
        messages.append(original)

        const replacement = document.createElement('div')
        replacement.id = 'hapi-message-tool-group:tool-group:call-2'
        replacement.setAttribute('data-hapi-source-message-ids', 'msg-0 msg-1')

        const saved = {
            anchor: { id: original.id, topOffset: 10 },
            element: original,
            sourceMessageId: 'msg-1'
        }

        // A page apply re-creates the row under a new id; the old element is
        // gone and getElementById can no longer find the anchor.
        original.remove()
        messages.append(replacement)

        expect(resolveHistoryAnchorElement(saved, viewport)).toBe(replacement)
        expect(resolveHistoryAnchorElement({ ...saved, sourceMessageId: null }, viewport)).toBeNull()

        viewport.remove()
    })

    it('leaves viewport ownership to tail-following, jumps, loads, and settling', () => {
        const base = {
            hasAnchor: true,
            autoScrollEnabled: false,
            searchTargetLocked: false,
            pendingScrollRestore: false,
            tailScrollInProgress: false,
            initialScrollSettling: false,
            outlineJumpInProgress: false
        }

        expect(shouldPreserveHistoryScrollAnchor({ ...base, hasAnchor: false })).toBe(false)
        expect(shouldPreserveHistoryScrollAnchor({ ...base, autoScrollEnabled: true })).toBe(false)
        expect(shouldPreserveHistoryScrollAnchor({ ...base, searchTargetLocked: true })).toBe(false)
        expect(shouldPreserveHistoryScrollAnchor({ ...base, pendingScrollRestore: true })).toBe(false)
        expect(shouldPreserveHistoryScrollAnchor({ ...base, tailScrollInProgress: true })).toBe(false)
        expect(shouldPreserveHistoryScrollAnchor({ ...base, initialScrollSettling: true })).toBe(false)
        expect(shouldPreserveHistoryScrollAnchor({ ...base, outlineJumpInProgress: true })).toBe(false)
    })

    it('resolves a streamed card anchor to its raw message id, not the stream id', () => {
        // A Pi assistant card renders with its stream id in the DOM id, while
        // the store protects rows by canonical message id.
        const group = document.createElement('div')
        group.id = 'hapi-message-agent-text:stream-abc:0'
        group.setAttribute('data-hapi-source-message-ids', 'raw-msg-1 raw-msg-2')
        document.body.append(group)

        expect(anchorMessageIdFromAnchor({ id: group.id, topOffset: 0 })).toBe('raw-msg-1')

        group.remove()
    })

    it('falls back to the DOM id for kinds that embed a raw message id', () => {
        expect(anchorMessageIdFromAnchor({ id: 'hapi-message-user-text:raw-msg-9', topOffset: 0 }))
            .toBe('raw-msg-9')
    })

    it('restores the captured message to the same viewport offset', () => {
        const viewport = document.createElement('div')
        const message = document.createElement('div')
        message.id = 'anchored-message'
        viewport.append(message)
        document.body.append(viewport)
        viewport.scrollTop = 200

        vi.spyOn(viewport, 'getBoundingClientRect').mockReturnValue(rect({ top: 100, bottom: 500 }))
        vi.spyOn(message, 'getBoundingClientRect').mockReturnValue(rect({ top: 180, bottom: 260 }))

        expect(restoreScrollAnchor(viewport, { id: 'anchored-message', topOffset: 30 })).toBe(true)
        expect(viewport.scrollTop).toBe(250)

        viewport.remove()
    })

    it('waits until assistant-ui has applied the loaded history version', () => {
        expect(hasAppliedHistoryVersion(4, 4)).toBe(false)
        expect(hasAppliedHistoryVersion(4, 5)).toBe(true)
    })
})

describe('top-triggered history loading', () => {
    it('recognizes an underfilled viewport and a top sentinel inside the preload margin', () => {
        expect(shouldLoadOlderForViewport({
            scrollHeight: 300,
            clientHeight: 500,
            viewportTop: 100,
            sentinelTop: 100,
            sentinelBottom: 101
        })).toBe(true)
        expect(shouldLoadOlderForViewport({
            scrollHeight: 1_000,
            clientHeight: 500,
            viewportTop: 100,
            sentinelTop: -200,
            sentinelBottom: -199
        })).toBe(false)
    })

    it('defers an intersection signal until the initial scroll-settling deadline', () => {
        expect(getHistoryCoverageRetryDelay(2_800, 1_000)).toBe(1_816)
        expect(getHistoryCoverageRetryDelay(900, 1_000)).toBe(16)
    })

    it('shows pull feedback at 16px and arms release loading at 64px', () => {
        expect(getPullToLoadState(15)).toBe('idle')
        expect(getPullToLoadState(16)).toBe('pulling')
        expect(getPullToLoadState(63)).toBe('pulling')
        expect(getPullToLoadState(64)).toBe('ready')
    })
})

describe('outline target loading', () => {
    it('loads older messages through the scroll-preserving wrapper until the target appears', async () => {
        const loadOlderPreservingScroll = vi.fn<() => Promise<boolean>>()
        let loadCount = 0
        loadOlderPreservingScroll.mockImplementation(async () => {
            loadCount += 1
            return true
        })

        const findTarget = vi.fn((anchorId: string) => {
            if (anchorId !== 'hapi-message-user-text:target') {
                return null
            }
            return loadCount >= 2 ? document.createElement('div') : null
        })

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:target',
            findTarget,
            hasMoreMessages: () => loadCount < 2,
            loadOlderPreservingScroll
        })

        expect(target).toBeInstanceOf(HTMLElement)
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(2)
        expect(findTarget).toHaveBeenCalledWith('hapi-message-user-text:target')
    })

    it('stops when history is exhausted before the target is loaded', async () => {
        const loadOlderPreservingScroll = vi.fn(async () => false)

        const target = await locateOutlineTargetMessage({
            targetMessageId: 'user-text:missing',
            findTarget: () => null,
            hasMoreMessages: () => true,
            loadOlderPreservingScroll
        })

        expect(target).toBeNull()
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(1)
    })

    it('uses the rendered anchor without loading context when the row is already in the window', async () => {
        const rendered = document.createElement('div')
        const loadMessageContext = vi.fn(async () => true)
        const loadOlderPreservingScroll = vi.fn(async () => true)

        const target = await focusOutlineTargetMessage({
            targetMessageId: 'user-text:rendered',
            sourceMessageId: 'rendered',
            findTarget: (anchorId) => anchorId === 'hapi-message-user-text:rendered' ? rendered : null,
            loadMessageContext,
            hasMoreMessages: () => false,
            loadOlderPreservingScroll
        })

        expect(target).toBe(rendered)
        expect(loadMessageContext).not.toHaveBeenCalled()
        expect(loadOlderPreservingScroll).not.toHaveBeenCalled()
    })

    it('loads bounded context for a prompt outside the window and waits for its render', async () => {
        const rendered = document.createElement('div')
        const loadMessageContext = vi.fn(async () => true)
        const waitForTarget = vi.fn(async () => rendered)
        const loadOlderPreservingScroll = vi.fn(async () => true)

        const target = await focusOutlineTargetMessage({
            targetMessageId: 'user-text:historical',
            sourceMessageId: 'historical',
            findTarget: () => null,
            loadMessageContext,
            waitForTarget,
            hasMoreMessages: () => true,
            loadOlderPreservingScroll
        })

        expect(target).toBe(rendered)
        expect(loadMessageContext).toHaveBeenCalledWith('historical')
        expect(waitForTarget).toHaveBeenCalledWith('hapi-message-user-text:historical')
        expect(loadOlderPreservingScroll).not.toHaveBeenCalled()
    })

    it('falls back to incremental paging when the context load fails', async () => {
        const rendered = document.createElement('div')
        const loadMessageContext = vi.fn(async () => false)
        const waitForTarget = vi.fn(async () => null)
        let loadCount = 0
        const loadOlderPreservingScroll = vi.fn(async () => {
            loadCount += 1
            return true
        })

        const target = await focusOutlineTargetMessage({
            targetMessageId: 'user-text:fallback',
            sourceMessageId: 'fallback',
            findTarget: () => loadCount > 0 ? rendered : null,
            loadMessageContext,
            waitForTarget,
            hasMoreMessages: () => loadCount < 1,
            loadOlderPreservingScroll
        })

        expect(target).toBe(rendered)
        expect(loadMessageContext).toHaveBeenCalledWith('fallback')
        expect(waitForTarget).not.toHaveBeenCalled()
        expect(loadOlderPreservingScroll).toHaveBeenCalledTimes(1)
    })

    it('drops the result when a newer outline selection replaced this one', async () => {
        const loadMessageContext = vi.fn(async () => true)
        const waitForTarget = vi.fn(async () => document.createElement('div'))
        let current = true

        const pending = focusOutlineTargetMessage({
            targetMessageId: 'user-text:stale',
            sourceMessageId: 'stale',
            findTarget: () => null,
            loadMessageContext,
            waitForTarget,
            hasMoreMessages: () => false,
            loadOlderPreservingScroll: async () => false,
            isCurrent: () => current
        })
        current = false

        expect(await pending).toBeNull()
        expect(waitForTarget).not.toHaveBeenCalled()
    })
})

describe('sticky prompt stepping', () => {
    const items: ConversationOutlineItem[] = outlineItems.map((item, index) => ({
        ...item,
        id: `outline:user-text:s${index + 1}`,
        targetMessageId: `user-text:s${index + 1}`
    }))
    const threeItems: ConversationOutlineItem[] = [
        ...items,
        {
            ...items[1]!,
            id: 'outline:user-text:s3',
            targetMessageId: 'user-text:s3'
        }
    ]

    it('steps from the pinned turn when no step is in flight', () => {
        expect(resolveStickyStepTarget({
            items,
            baseItemId: null,
            pinnedPosition: 1,
            direction: 1
        })).toBe(items[1])
        expect(resolveStickyStepTarget({
            items,
            baseItemId: null,
            pinnedPosition: 2,
            direction: -1
        })).toBe(items[0])
    })

    it('continues from the in-flight target so quick clicks accumulate', () => {
        // The viewport still measures turn 1 while the first click's jump is
        // still loading, but that step is already heading to turn 2, so the
        // next click must resolve turn 3.
        expect(resolveStickyStepTarget({
            items: threeItems,
            baseItemId: threeItems[1]!.id,
            pinnedPosition: 1,
            direction: 1
        })).toBe(threeItems[2])
        expect(resolveStickyStepTarget({
            items: threeItems,
            baseItemId: threeItems[1]!.id,
            pinnedPosition: 1,
            direction: -1
        })).toBe(threeItems[0])
    })

    it('falls back to the measured position when the in-flight target left the index', () => {
        expect(resolveStickyStepTarget({
            items,
            baseItemId: 'outline:user-text:gone',
            pinnedPosition: 2,
            direction: -1
        })).toBe(items[0])
    })

    it('returns null at either edge of the session outline', () => {
        expect(resolveStickyStepTarget({
            items,
            baseItemId: null,
            pinnedPosition: 1,
            direction: -1
        })).toBeNull()
        expect(resolveStickyStepTarget({
            items,
            baseItemId: null,
            pinnedPosition: items.length,
            direction: 1
        })).toBeNull()
        expect(resolveStickyStepTarget({
            items,
            baseItemId: null,
            pinnedPosition: 0,
            direction: 1
        })).toBeNull()
    })
})

describe('revealStepTarget', () => {
    const anchor = () => document.createElement('div')

    it('uses an already rendered target without paging', async () => {
        const rendered = anchor()
        const loadOlder = vi.fn(async () => true)
        const loadNewer = vi.fn(async () => true)

        const target = await revealStepTarget({
            direction: -1,
            findTarget: () => rendered,
            waitForTarget: async () => null,
            loadOlder,
            loadNewer,
            canLoadOlder: () => true,
            canLoadNewer: () => true,
            isCurrent: () => true
        })

        expect(target).toBe(rendered)
        expect(loadOlder).not.toHaveBeenCalled()
        expect(loadNewer).not.toHaveBeenCalled()
    })

    it('prepends older pages until the prompt is rendered', async () => {
        const rendered = anchor()
        let pages = 0
        const loadOlder = vi.fn(async () => {
            pages += 1
            return true
        })

        const target = await revealStepTarget({
            direction: -1,
            findTarget: () => pages >= 2 ? rendered : null,
            waitForTarget: async () => null,
            loadOlder,
            loadNewer: async () => false,
            canLoadOlder: () => pages < 2,
            canLoadNewer: () => false,
            isCurrent: () => true
        })

        expect(target).toBe(rendered)
        expect(loadOlder).toHaveBeenCalledTimes(2)
    })

    it('waits for the render after a page applies', async () => {
        const rendered = anchor()
        const loadOlder = vi.fn(async () => true)
        const waitForTarget = vi.fn(async () => rendered)

        const target = await revealStepTarget({
            direction: -1,
            findTarget: () => null,
            waitForTarget,
            loadOlder,
            loadNewer: async () => false,
            canLoadOlder: () => true,
            canLoadNewer: () => false,
            isCurrent: () => true
        })

        expect(target).toBe(rendered)
        expect(loadOlder).toHaveBeenCalledTimes(1)
        expect(waitForTarget).toHaveBeenCalledTimes(1)
    })

    it('grows newer rows for a downward step', async () => {
        const rendered = anchor()
        let pages = 0
        const loadNewer = vi.fn(async () => {
            pages += 1
            return true
        })

        const target = await revealStepTarget({
            direction: 1,
            findTarget: () => pages >= 1 ? rendered : null,
            waitForTarget: async () => null,
            loadOlder: async () => false,
            loadNewer,
            canLoadOlder: () => false,
            canLoadNewer: () => true,
            isCurrent: () => true
        })

        expect(target).toBe(rendered)
        expect(loadNewer).toHaveBeenCalledTimes(1)
    })

    it('stops when the window has no more pages in that direction', async () => {
        const loadOlder = vi.fn(async () => true)

        const target = await revealStepTarget({
            direction: -1,
            findTarget: () => null,
            waitForTarget: async () => null,
            loadOlder,
            loadNewer: async () => false,
            canLoadOlder: () => false,
            canLoadNewer: () => false,
            isCurrent: () => true
        })

        expect(target).toBeNull()
        expect(loadOlder).not.toHaveBeenCalled()
    })

    it('drops the result when a newer step replaced this one', async () => {
        const loadOlder = vi.fn(async () => true)
        let current = false

        const target = await revealStepTarget({
            direction: -1,
            findTarget: () => null,
            waitForTarget: async () => anchor(),
            loadOlder,
            loadNewer: async () => false,
            canLoadOlder: () => true,
            canLoadNewer: () => false,
            isCurrent: () => current
        })

        expect(target).toBeNull()
        expect(loadOlder).not.toHaveBeenCalled()
    })

    it('bounds the page count when the anchor never appears', async () => {
        const loadOlder = vi.fn(async () => true)

        const target = await revealStepTarget({
            direction: -1,
            findTarget: () => null,
            waitForTarget: async () => null,
            loadOlder,
            loadNewer: async () => false,
            canLoadOlder: () => true,
            canLoadNewer: () => false,
            isCurrent: () => true,
            maxPages: 2
        })

        expect(target).toBeNull()
        expect(loadOlder).toHaveBeenCalledTimes(2)
    })
})

describe('share turn snapshots', () => {
    it('restores the preceding user prompt when a long rendered turn only contains assistant DOM', () => {
        const assistant = { html: '<div data-hapi-message-role="assistant">answer</div>', text: 'answer', role: 'assistant' as const }
        const user = { html: '', text: 'original long-conversation prompt', role: 'user' as const }

        expect(prependMissingUserSnapshot([assistant], user)).toEqual([user, assistant])
    })

    it('does not duplicate a user prompt already captured from the DOM', () => {
        const user = { html: '<div data-hapi-message-role="user">prompt</div>', text: 'prompt' }
        const fallback = { html: '', text: 'prompt', role: 'user' as const }

        expect(prependMissingUserSnapshot([user], fallback)).toEqual([user])
    })
})

describe('sticky prompt park delta', () => {
    it('parks the prompt root at the bar bottom edge', () => {
        // A 40px bar: the root ends at the top of the covered strip, so the
        // 12px message gap puts the first answer row on the reading line.
        expect(getStickyPromptParkDelta({ anchorBottom: 300, viewportTop: 100 })).toBe(160)
    })

    it('scrolls upward when the target prompt is above the viewport', () => {
        expect(getStickyPromptParkDelta({ anchorBottom: 60, viewportTop: 100 })).toBe(-80)
    })

    it('uses the provided bar height', () => {
        expect(getStickyPromptParkDelta({ anchorBottom: 300, viewportTop: 100, barHeight: 52 })).toBe(148)
    })
})
