import { describe, expect, it } from 'bun:test'
import { isUploadPathTitle, isUsableTitleText, stripUploadPathReferences } from './uploadPathTitle'

describe('isUploadPathTitle', () => {
    it('detects legacy upload-path titles, including truncated ones', () => {
        expect(isUploadPathTitle('@/var/folders/dq/jl90n5z120v834fmz6snb58w0000gn/T/hapi-blobs/sid-abc/1-image.png…')).toBe(true)
        expect(isUploadPathTitle('@/tmp/hapi-blobs/sid-abc/1-image.png')).toBe(true)
        expect(isUploadPathTitle('@C:\\Users\\me\\AppData\\Local\\Temp\\hapi-blobs\\sid-abc\\1-image.png')).toBe(true)
        // Truncated before the upload marker.
        expect(isUploadPathTitle('@/var/folders/dq/jl90n5z120v834fmz6snb58w0000gn/T/hapi-b…')).toBe(true)
    })

    it('keeps real titles, prompt text and non-upload mentions', () => {
        expect(isUploadPathTitle('Fix the login redirect')).toBe(false)
        expect(isUploadPathTitle('@/Users/me/src/app.ts please review this')).toBe(false)
        expect(isUploadPathTitle('@src/app.ts review the handler')).toBe(false)
        expect(isUploadPathTitle('/frontend-prod release with a version bump')).toBe(false)
        expect(isUploadPathTitle(undefined)).toBe(false)
        expect(isUploadPathTitle(null)).toBe(false)
        expect(isUploadPathTitle('   ')).toBe(false)
    })
})

describe('isUsableTitleText', () => {
    it('treats missing and upload-path titles as unusable', () => {
        expect(isUsableTitleText('Fix the login redirect')).toBe(true)
        expect(isUsableTitleText('')).toBe(false)
        expect(isUsableTitleText(undefined)).toBe(false)
        expect(isUsableTitleText('@/tmp/hapi-blobs/sid/1-image.png')).toBe(false)
    })
})

describe('stripUploadPathReferences', () => {
    it('removes upload references while keeping the prompt text', () => {
        expect(stripUploadPathReferences(
            '@/var/folders/dq/x/T/hapi-blobs/sid-a/1-image.png\n\nfix the build'
        )).toBe('fix the build')
        expect(stripUploadPathReferences('@/tmp/hapi-blobs/sid-a/1-image.png')).toBe('')
        expect(stripUploadPathReferences('Review @src/app.ts')).toBe('Review @src/app.ts')
    })
})
