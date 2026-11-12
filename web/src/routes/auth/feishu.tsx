import { LoadingState } from '@/components/LoadingState'
import { useTranslation } from '@/lib/use-translation'

/**
 * The OAuth callback is exchanged by `useAuthSource` before the app renders
 * normally; this route only prevents a not-found flash while that happens.
 */
export default function FeishuCallbackPage() {
    const { t } = useTranslation()
    return (
        <div className="h-full flex items-center justify-center p-4">
            <LoadingState label={t('authorizing')} className="text-sm" />
        </div>
    )
}
