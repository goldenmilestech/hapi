import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { ConversationOutlineItem } from '@/chat/outline'
import { getConversationMessageAnchorId } from '@/chat/outline'
import { formatMessageTimestampTitle, formatOutlineTimestamp } from '@/chat/presentation'
import { useTranslation } from '@/lib/use-translation'
import { cn } from '@/lib/utils'

/** Keep in sync with the `h-10` inner row. */
export const STICKY_PROMPT_BAR_HEIGHT_PX = 40
/** Breathing room between the bar and the first readable row. */
export const STICKY_PROMPT_READING_GAP_PX = 12

type PromptRect = {
    top: number
    bottom: number
}

/**
 * State of the turn at the reading line.
 *
 * - `pinned`: the prompt crossed the line and is out of view; show its bar.
 * - `visible`: the prompt crossed the line but is still on screen; hide the
 *   bar because the bubble is its own header.
 * - `above-first`: the line sits above the first rendered prompt, which means
 *   the loaded message window starts in the middle of an answer and the
 *   turn's own prompt is not rendered at all.
 */
export type PinnedPromptTurn =
    | { kind: 'pinned'; index: number }
    | { kind: 'visible'; index: number }
    | { kind: 'above-first' }

/**
 * Pick the turn whose question the sticky bar should pin.
 *
 * The turn is the last prompt whose *top* crossed the reading line, not the
 * last whose bottom did: when the viewport lands in the gap above a prompt,
 * the visible content still belongs to the previous turn.
 *
 * @internal Exported for unit testing.
 */
export function resolvePinnedPrompt(
    rects: readonly PromptRect[],
    viewportTop: number,
    readingOffsetPx: number = STICKY_PROMPT_BAR_HEIGHT_PX + STICKY_PROMPT_READING_GAP_PX
): PinnedPromptTurn {
    const readingLine = viewportTop + readingOffsetPx
    let turnIndex = -1
    for (let index = 0; index < rects.length; index += 1) {
        if (rects[index].top <= readingLine) {
            turnIndex = index
        }
    }
    if (turnIndex === -1) {
        return { kind: 'above-first' }
    }
    if (rects[turnIndex].bottom > readingLine) {
        return { kind: 'visible', index: turnIndex }
    }
    return { kind: 'pinned', index: turnIndex }
}

/** @internal Exported for unit testing. */
export function findPinnedPromptIndex(
    rects: readonly PromptRect[],
    viewportTop: number,
    readingOffsetPx: number = STICKY_PROMPT_BAR_HEIGHT_PX + STICKY_PROMPT_READING_GAP_PX
): number | null {
    const turn = resolvePinnedPrompt(rects, viewportTop, readingOffsetPx)
    return turn.kind === 'pinned' ? turn.index : null
}

type PinnedPrompt = {
    item: ConversationOutlineItem
    /** 1-based index in the session-wide outline index. */
    position: number
    /** Prompt count in the session-wide outline index. */
    total: number
}

/** The turn the reader is stepping from. */
export type StickyPromptStep = {
    item: ConversationOutlineItem
    /** 1-based index in the session-wide outline index. */
    position: number
}

type StickyPromptBarProps = {
    viewportRef: RefObject<HTMLDivElement | null>
    contentRef: RefObject<HTMLDivElement | null>
    items: readonly ConversationOutlineItem[]
    /** Message/history revision; re-measure when the rendered window swaps. */
    revision: number | string
    /** Search jumps and the outline drawer own the top edge while open. */
    hidden?: boolean
    /**
     * Turn to keep pinned after a jump, even while its bubble is still on
     * screen. A jump lands the prompt bubble just below the bar so the reader
     * can see the message itself; geometry alone would hide the bar as
     * "visible", removing the step and locate controls. The thread clears the
     * hold on the next manual scroll.
     */
    heldItem?: ConversationOutlineItem | null
    onLocate: (item: ConversationOutlineItem) => void
    onStep: (direction: -1 | 1, current: StickyPromptStep) => void
}

/**
 * Pins the question of the turn currently under the reading line to the top
 * of the thread. Kept out of the scroll container so the bar itself never
 * affects the message layout or the scroll anchors.
 */
export function StickyPromptBar(props: StickyPromptBarProps) {
    const { t, locale } = useTranslation()
    const [pinned, setPinned] = useState<PinnedPrompt | null>(null)
    const pinnedRef = useRef<PinnedPrompt | null>(null)

    const itemByAnchorId = useMemo(() => {
        const map = new Map<string, ConversationOutlineItem>()
        for (const item of props.items) {
            map.set(getConversationMessageAnchorId(item.targetMessageId), item)
        }
        return map
    }, [props.items])

    const indexById = useMemo(() => {
        const map = new Map<string, number>()
        props.items.forEach((item, index) => {
            map.set(item.id, index)
        })
        return map
    }, [props.items])

    const publish = useCallback((next: PinnedPrompt | null) => {
        const current = pinnedRef.current
        const unchanged = current?.item === next?.item
            && current?.position === next?.position
            && current?.total === next?.total
        if (unchanged) {
            return
        }
        pinnedRef.current = next
        setPinned(next)
    }, [])

    const sync = useCallback(() => {
        const viewport = props.viewportRef.current
        const content = props.contentRef.current
        if (!viewport || !content) {
            publish(null)
            return
        }

        const viewportTop = viewport.getBoundingClientRect().top
        const items: ConversationOutlineItem[] = []
        const rects: PromptRect[] = []
        // Only prompts that are both rendered and indexed can be pinned; CLI
        // output and system notes share the user role attribute but miss the
        // outline anchor id, so the map lookup filters them out.
        content.querySelectorAll<HTMLElement>('[data-hapi-message-role="user"]').forEach((element) => {
            const item = itemByAnchorId.get(element.id)
            if (!item) {
                return
            }
            // Measure the bubble, not the message root: the root also owns the
            // hover action row, which would delay the bar by its full height.
            const measured = element.querySelector<HTMLElement>('.happy-user-bubble') ?? element
            const rect = measured.getBoundingClientRect()
            items.push(item)
            rects.push({ top: rect.top, bottom: rect.bottom })
        })

        const total = Math.max(props.items.length, items.length)
        // A landed jump keeps its turn on the bar even while the prompt bubble
        // is visible below it. Without the hold the bar would hide as
        // "visible" and the reader would lose the step/locate controls right
        // after using them.
        const heldItem = props.heldItem
        const heldIndex = heldItem ? indexById.get(heldItem.id) : undefined
        if (heldItem && heldIndex !== undefined) {
            // Prefer the live index entry: the held object can predate a
            // window merge that refreshed its label.
            publish({ item: props.items[heldIndex] ?? heldItem, position: heldIndex + 1, total })
            return
        }
        const turn = resolvePinnedPrompt(rects, viewportTop)
        if (turn.kind === 'pinned') {
            const item = items[turn.index]
            publish({
                item,
                // The outline index is session-wide, so the pinned item's
                // position and the total stay stable while the window swaps.
                position: (indexById.get(item.id) ?? turn.index) + 1,
                total
            })
            return
        }
        if (turn.kind === 'visible') {
            publish(null)
            return
        }
        // The loaded window starts mid-answer, so the turn's own prompt is not
        // rendered. Keep a bar for the outline item just before the first
        // rendered prompt: the reading line still belongs to that turn, and
        // the reader can load it with the locator or the step buttons.
        const firstRendered = items[0]
        const firstPosition = firstRendered ? indexById.get(firstRendered.id) : undefined
        if (firstPosition !== undefined && firstPosition > 0) {
            const previous = props.items[firstPosition - 1]
            if (previous) {
                publish({ item: previous, position: firstPosition, total })
                return
            }
        }
        publish(null)
    }, [itemByAnchorId, indexById, props.contentRef, props.heldItem, props.items, props.viewportRef, publish])

    useEffect(() => {
        const viewport = props.viewportRef.current
        if (!viewport) {
            return
        }
        let frame = 0
        const schedule = () => {
            if (frame !== 0) {
                return
            }
            frame = requestAnimationFrame(() => {
                frame = 0
                sync()
            })
        }
        viewport.addEventListener('scroll', schedule, { passive: true })
        window.addEventListener('resize', schedule)
        schedule()
        return () => {
            viewport.removeEventListener('scroll', schedule)
            window.removeEventListener('resize', schedule)
            if (frame !== 0) {
                cancelAnimationFrame(frame)
            }
        }
    }, [props.viewportRef, props.revision, props.hidden, sync])

    const step = useCallback((direction: -1 | 1) => {
        // Re-measure first so a click on a fast-scrolling viewport still steps
        // from the turn the reader actually sees. Resolving the next turn is
        // the thread's job: while a step is still loading or settling, the
        // next click must continue from that step's target rather than from
        // geometry that has not caught up yet.
        sync()
        const current = pinnedRef.current
        if (!current) {
            return
        }
        props.onStep(direction, { item: current.item, position: current.position })
    }, [props.onStep, sync])

    const visible = pinned !== null && props.hidden !== true
    const createdAt = pinned ? new Date(pinned.item.createdAt) : null
    const canGoPrevious = Boolean(pinned && pinned.position > 1)
    const canGoNext = Boolean(pinned && pinned.position < pinned.total)
    const locateLabel = t('session.stickyPrompt.locate')

    return (
        <div
            role="region"
            aria-label={t('session.stickyPrompt.region')}
            aria-hidden={!visible}
            inert={!visible}
            data-testid="sticky-prompt-bar"
            data-visible={visible ? 'true' : 'false'}
            className={cn(
                'absolute inset-x-0 top-0 z-10 border-b border-[var(--app-border)] bg-[var(--app-bg)]/85 backdrop-blur-md',
                'transition-[transform,opacity] duration-150 ease-out motion-reduce:transition-none',
                visible ? 'translate-y-0 opacity-100' : 'pointer-events-none -translate-y-full opacity-0'
            )}
        >
            <div className="mx-auto flex h-10 w-full max-w-content min-w-0 items-center gap-2 px-3">
                <button
                    type="button"
                    onClick={() => {
                        if (pinned) {
                            props.onLocate(pinned.item)
                        }
                    }}
                    disabled={pinned === null}
                    title={locateLabel}
                    aria-label={locateLabel}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--app-subtle-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)]"
                >
                    <QuoteIcon className="h-3.5 w-3.5 shrink-0 text-[var(--app-hint)]" />
                    <span className="truncate text-[13px] leading-none text-[var(--app-fg)]/90">
                        {pinned?.item.label ?? ''}
                    </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 text-[var(--app-hint)]">
                    {pinned ? (
                        <span
                            className="mr-1 border-r border-[var(--app-border)] pr-2 text-[11px] leading-none tabular-nums"
                            aria-label={t('session.stickyPrompt.position', {
                                current: pinned.position,
                                total: pinned.total
                            })}
                        >
                            {pinned.position} / {pinned.total}
                        </span>
                    ) : null}
                    {createdAt ? (
                        <time
                            dateTime={createdAt.toISOString()}
                            title={formatMessageTimestampTitle(createdAt)}
                            className="px-1 text-xs leading-none tabular-nums"
                        >
                            {formatOutlineTimestamp(createdAt, locale)}
                        </time>
                    ) : null}
                    <BarButton
                        label={locateLabel}
                        disabled={pinned === null}
                        onClick={() => {
                            if (pinned) {
                                props.onLocate(pinned.item)
                            }
                        }}
                    >
                        <LocateIcon className="h-3.5 w-3.5" />
                    </BarButton>
                    <BarButton
                        label={t('session.stickyPrompt.previous')}
                        disabled={!canGoPrevious}
                        onClick={() => step(-1)}
                    >
                        <ChevronUpIcon className="h-3.5 w-3.5" />
                    </BarButton>
                    <BarButton
                        label={t('session.stickyPrompt.next')}
                        disabled={!canGoNext}
                        onClick={() => step(1)}
                    >
                        <ChevronDownIcon className="h-3.5 w-3.5" />
                    </BarButton>
                </div>
            </div>
        </div>
    )
}

function BarButton(props: {
    label: string
    disabled?: boolean
    onClick: () => void
    children: ReactNode
}) {
    return (
        <button
            type="button"
            onClick={props.onClick}
            disabled={props.disabled}
            title={props.label}
            aria-label={props.label}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-[var(--app-hint)] transition-colors hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-[var(--app-hint)]"
        >
            {props.children}
        </button>
    )
}

function QuoteIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
        >
            <path d="M10 6.5C7 8 5.2 10.6 5.2 14c0 3.2 1.8 5.4 4.4 5.4 2.2 0 3.8-1.6 3.8-3.7 0-2-1.4-3.4-3.2-3.4-.4 0-.8 0-1 .1.3-1.6 1.6-3.1 3.3-4.1L10 6.5Zm9.2 0C16.2 8 14.4 10.6 14.4 14c0 3.2 1.8 5.4 4.4 5.4 2.2 0 3.8-1.6 3.8-3.7 0-2-1.4-3.4-3.2-3.4-.4 0-.8 0-1 .1.3-1.6 1.6-3.1 3.3-4.1l-2.5-1.8Z" />
        </svg>
    )
}

function LocateIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </svg>
    )
}

function ChevronUpIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m18 15-6-6-6 6" />
        </svg>
    )
}

function ChevronDownIcon(props: { className?: string }) {
    return (
        <svg
            className={props.className}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="m6 9 6 6 6-6" />
        </svg>
    )
}
