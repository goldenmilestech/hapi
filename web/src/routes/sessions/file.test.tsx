import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { formatFileMetadata } from '@/lib/file-metadata'
import { encodeBase64 } from '@/lib/utils'
import FilePage from './file'

const goBackMock = vi.fn()
const navigateMock = vi.hoisted(() => vi.fn())
const copyMock = vi.hoisted(() => vi.fn())
const getGitDiffFileMock = vi.hoisted(() => vi.fn())
const readSessionFileMock = vi.hoisted(() => vi.fn())
const searchSessionFilesMock = vi.hoisted(() => vi.fn())

const sampleMarkdown = '# Heading\n\n| Col A | Col B |\n| --- | --- |\n| one | two |'
const filePath = 'docs/README.md'
const encodedPath = encodeBase64(filePath)
const encodedContent = encodeBase64(sampleMarkdown)
const fileSize = 1024
const fileModified = 1_784_175_060_000

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'session-1' }),
    useSearch: () => ({
        path: encodedPath,
        staged: undefined,
    }),
    useNavigate: () => navigateMock,
}))

vi.mock('@/lib/app-context', () => ({
    useAppContext: () => ({
        api: {
            getGitDiffFile: getGitDiffFileMock,
            readSessionFile: readSessionFileMock,
            searchSessionFiles: searchSessionFilesMock,
        },
    }),
}))

vi.mock('@/hooks/useAppGoBack', () => ({
    useAppGoBack: () => goBackMock,
}))

vi.mock('@/hooks/useCopyToClipboard', () => ({
    useCopyToClipboard: () => ({
        copied: false,
        copy: copyMock,
    }),
}))

vi.mock('@/lib/shiki', () => ({
    langAlias: { md: 'markdown' },
    useShikiHighlighter: (content: string) => content,
}))

vi.mock('@/components/MarkdownRenderer', () => ({
    MarkdownRenderer: (props: { content: string }) => (
        <div data-testid="markdown-preview">{props.content}</div>
    ),
}))

function renderWithProviders() {
    const queryClient = new QueryClient({
        defaultOptions: {
            queries: { retry: false },
        },
    })
    return render(
        <QueryClientProvider client={queryClient}>
            <I18nProvider>
                <FilePage />
            </I18nProvider>
        </QueryClientProvider>
    )
}

describe('FilePage markdown preview', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        getGitDiffFileMock.mockResolvedValue({ success: true, stdout: '' })
        readSessionFileMock.mockResolvedValue({
            success: true,
            content: encodedContent,
            size: fileSize,
            modified: fileModified,
        })
        searchSessionFilesMock.mockReset()
        searchSessionFilesMock.mockResolvedValue({ success: true, files: [] })
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('renders markdown preview by default and toggles to source', async () => {
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toHaveTextContent('# Heading')
        })
        expect(screen.getByTestId('markdown-preview').closest('.file-preview-scroll-content')).not.toBeNull()
        expect(screen.getByTestId('markdown-preview').closest('.file-preview-scroll-y')).not.toBeNull()
        expect(screen.getByText(formatFileMetadata(fileSize, fileModified, 'en')!)).toBeInTheDocument()
        expect(screen.getAllByText(filePath)).toHaveLength(1)
        const previewCopyButton = screen.getByRole('button', { name: 'Copy file content' })
        expect(previewCopyButton.closest('[data-hapi-file-content-header="true"]')).not.toBeNull()
        expect(previewCopyButton).not.toHaveClass('absolute')
        fireEvent.click(previewCopyButton)
        expect(copyMock).toHaveBeenCalledWith(sampleMarkdown)
        expect(screen.getByRole('button', { name: 'Preview' })).toHaveClass('opacity-80')

        fireEvent.click(screen.getByRole('button', { name: 'Source' }))

        await waitFor(() => {
            expect(screen.getByRole('code')).toHaveTextContent('# Heading')
        })
        const sourcePreview = screen.getByRole('code').closest('[data-hapi-file-source-preview="true"]')
        const sourceCopyButton = screen.getByRole('button', { name: 'Copy file content' })
        expect(sourcePreview).not.toBeNull()
        expect(sourcePreview).toContainElement(sourceCopyButton)
        expect(sourceCopyButton.closest('[data-hapi-file-content-header="true"]')).not.toBeNull()
        expect(sourceCopyButton).not.toHaveClass('absolute')
        expect(screen.queryByTestId('markdown-preview')).not.toBeInTheDocument()

        fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
    })

    it('collapses long preview errors until clicked', async () => {
        const tail = 'FULL ERROR TAIL'
        const longError = `Command failed: git diff --no-ext-diff -- TASKS.md ${'diagnostic '.repeat(30)}${tail}`
        getGitDiffFileMock.mockResolvedValue({ success: false, error: longError })

        renderWithProviders()

        const errorToggle = await screen.findByRole('button', { name: /Show full error/ })
        expect(screen.getAllByRole('alert')).toHaveLength(1)
        expect(errorToggle).toHaveAttribute('aria-expanded', 'false')
        expect(errorToggle).toHaveTextContent('…')
        expect(errorToggle).not.toHaveTextContent(tail)

        fireEvent.click(errorToggle)
        expect(errorToggle).toHaveAttribute('aria-expanded', 'true')
        expect(errorToggle).toHaveTextContent(longError)

        fireEvent.click(errorToggle)
        expect(errorToggle).toHaveAttribute('aria-expanded', 'false')
        expect(errorToggle).not.toHaveTextContent(tail)
    })

    it('uses the shared code-wrap preference for the source preview', async () => {
        window.localStorage.setItem('hapi-code-wrap', '1')
        renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        fireEvent.click(screen.getByRole('button', { name: 'Source' }))

        await waitFor(() => {
            expect(screen.getByRole('code')).toHaveTextContent('# Heading')
        })
        const sourceCode = screen.getByRole('code')
        const sourcePre = sourceCode.closest('pre')
        const wrapToggle = screen.getByRole('button', { pressed: true })

        expect(wrapToggle).toBeInTheDocument()
        expect(sourcePre).toHaveStyle({ whiteSpace: 'pre-wrap', wordBreak: 'break-word' })

        fireEvent.click(wrapToggle)

        expect(screen.getByRole('button', { pressed: false })).toBeInTheDocument()
        expect(sourcePre).toHaveStyle({ whiteSpace: 'pre' })
        expect(window.localStorage.getItem('hapi-code-wrap')).toBeNull()
    })

    it('preserves the file preview scroll position across route remounts', async () => {
        const firstRender = renderWithProviders()

        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const firstScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(firstScrollRegion).not.toBeNull()
        firstScrollRegion.scrollTop = 123
        firstRender.unmount()

        renderWithProviders()
        await waitFor(() => {
            expect(screen.getByTestId('markdown-preview')).toBeInTheDocument()
        })
        const secondScrollRegion = document.querySelector('[data-hapi-file-scroll="true"]') as HTMLElement
        expect(secondScrollRegion.scrollTop).toBe(123)
    })
})

describe('FilePage missing file fallback', () => {
    const missingError = "ENOENT: no such file or directory, realpath '/Users/ada/repo/docs/README.md'"

    beforeEach(() => {
        vi.clearAllMocks()
        getGitDiffFileMock.mockResolvedValue({ success: true, stdout: '' })
        readSessionFileMock.mockResolvedValue({ success: false, error: missingError })
        searchSessionFilesMock.mockReset()
        searchSessionFilesMock.mockResolvedValue({ success: true, files: [] })
        window.localStorage.clear()
        window.sessionStorage.clear()
    })

    it('opens the only same-name file automatically', async () => {
        searchSessionFilesMock.mockResolvedValue({
            success: true,
            files: [
                {
                    fileName: 'README.md',
                    filePath: 'packages/app/docs',
                    fullPath: 'packages/app/docs/README.md',
                    fileType: 'file',
                    modified: 300,
                },
            ],
        })

        renderWithProviders()

        await waitFor(() => {
            expect(navigateMock).toHaveBeenCalledWith({
                to: '/sessions/$sessionId/file',
                params: { sessionId: 'session-1' },
                search: { path: encodeBase64('packages/app/docs/README.md') },
                replace: true,
            })
        })
    })

    it('lists several matching files by modified time and opens the selected one', async () => {
        searchSessionFilesMock.mockResolvedValue({
            success: true,
            files: [
                {
                    fileName: 'README.md',
                    filePath: 'apps/docs',
                    fullPath: 'apps/docs/README.md',
                    fileType: 'file',
                    modified: 100,
                },
                {
                    fileName: 'README.md',
                    filePath: 'packages/docs',
                    fullPath: 'packages/docs/README.md',
                    fileType: 'file',
                    modified: 500,
                },
                {
                    fileName: 'README.md',
                    filePath: 'apps/other',
                    fullPath: 'apps/other/README.md',
                    fileType: 'file',
                    modified: 900,
                },
            ],
        })

        const { container } = renderWithProviders()

        await waitFor(() => {
            const candidates = Array.from(container.querySelectorAll('[data-hapi-file-candidate]'))
            expect(candidates.map((element) => element.getAttribute('data-hapi-file-candidate'))).toEqual([
                'packages/docs/README.md',
                'apps/docs/README.md',
            ])
        })
        expect(screen.getByText('File not found: docs/README.md')).toBeInTheDocument()
        expect(screen.getByText('Matching files in this workspace (2):')).toBeInTheDocument()
        expect(navigateMock).not.toHaveBeenCalled()

        fireEvent.click(container.querySelector('[data-hapi-file-candidate="packages/docs/README.md"]') as HTMLElement)

        expect(navigateMock).toHaveBeenCalledWith({
            to: '/sessions/$sessionId/file',
            params: { sessionId: 'session-1' },
            search: { path: encodeBase64('packages/docs/README.md') },
        })
    })

    it('keeps the read error when the workspace has no matching file', async () => {
        renderWithProviders()

        await screen.findByText('No matching files found in this workspace.')
        expect(screen.getByText(/Failed to read file/)).toBeInTheDocument()
        expect(navigateMock).not.toHaveBeenCalled()
    })
})
