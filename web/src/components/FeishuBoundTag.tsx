import { useTranslation } from '@/lib/use-translation'

function FeishuLinkIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className={props.className}
        >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
    )
}

type FeishuBoundTagProps = {
    /** `header` matches the 12px session metadata line; `list` stays at 10px. */
    variant?: 'list' | 'header'
    className?: string
}

export function FeishuBoundTag(props: FeishuBoundTagProps) {
    const { t } = useTranslation()
    const header = props.variant === 'header'
    return (
        <span
            data-testid={header ? 'session-header-feishu-bound' : 'session-feishu-bound'}
            title={t('session.item.feishuBound')}
            className={`inline-flex shrink-0 items-center rounded bg-[var(--app-subtle-bg)] text-[var(--app-hint)] ${
                header ? 'gap-1 px-1.5 py-0.5 text-xs' : 'gap-[3px] px-1 py-0.5 text-[10px]'
            } leading-none ${props.className ?? ''}`}
        >
            <FeishuLinkIcon className={header ? 'h-3 w-3 shrink-0' : 'h-2.5 w-2.5 shrink-0'} />
            {t('session.item.feishuBoundShort')}
        </span>
    )
}
