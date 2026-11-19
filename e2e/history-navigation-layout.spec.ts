import { expect, test, type Page } from '@playwright/test'

test.setTimeout(90000)

async function geometry(page: Page) {
    return page.evaluate(() => {
        const root = document.getElementById('root')!
        const chat = document.querySelector<HTMLElement>('.chat-scroll-y')!
        const footer = document.querySelector<HTMLElement>('[data-testid="navigation-composer"]')!
        const header = document.querySelector<HTMLElement>('[data-testid="navigation-header"]')!
        return {
            rootTop: root.scrollTop,
            rootHeight: root.clientHeight,
            rootScrollHeight: root.scrollHeight,
            headerTop: header.getBoundingClientRect().top,
            chatTop: chat.getBoundingClientRect().top,
            chatScrollTop: chat.scrollTop,
            composerBottom: footer.getBoundingClientRect().bottom,
            viewportHeight: innerHeight,
        }
    })
}

for (const device of [
    { name: 'desktop', width: 1280, height: 800, isMobile: false, hasTouch: false },
    { name: 'mobile', width: 390, height: 780, isMobile: true, hasTouch: true },
]) {
    test.describe(device.name, () => {
        test.use({
            viewport: { width: device.width, height: device.height },
            hasTouch: device.hasTouch,
            // Firefox supports the narrow layout, but not mobile emulation.
            isMobile: async ({ browserName }, use) => {
                await use(device.isMobile && browserName !== 'firefox')
            },
        })
        test('history selection keeps header and composer pinned to the app', async ({ page }) => {
            const errors: string[] = []
            page.on('pageerror', error => errors.push(error.message))
            await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&navigationMedia=1')
            await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
            await page.waitForTimeout(2000)
            const before = await geometry(page)
            expect(before.rootTop).toBe(0)
            expect(before.rootScrollHeight).toBeLessThanOrEqual(before.rootHeight + 1)
            await page.getByRole('button', { name: 'Open history', exact: true }).click()
            await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 1010')
            await page.getByRole('button', { name: /Fixture message 1010/ }).click()
            await expect(page.getByRole('searchbox', { name: 'Search outline items' })).toHaveCount(0)
            await page.waitForTimeout(1500)
            const after = await geometry(page)
            console.log(JSON.stringify({ device: device.name, before, after }))
            expect(after.rootTop).toBe(0)
            expect(after.rootScrollHeight).toBeLessThanOrEqual(after.rootHeight + 1)
            expect(after.headerTop).toBeCloseTo(before.headerTop, 0)
            expect(after.composerBottom).toBeCloseTo(after.viewportHeight, 0)
            await expect(page.locator('[id="hapi-message-user-text:m-1010"]')).toBeInViewport()
            // History pagination adds more image previews; no outer overflow.
            await page.evaluate(() => window.__probe.loadMore())
            await expect(page.locator('[id="hapi-message-user-text:m-801"]')).toBeAttached()
            await expect.poll(async () => (await geometry(page)).rootScrollHeight).toBeLessThanOrEqual(after.rootHeight + 1)
            await page.getByRole('button', { name: 'Open history', exact: true }).click()
            await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 810')
            await page.getByRole('button', { name: /Fixture message 810/ }).click()
            await expect(page.locator('[id="hapi-message-user-text:m-810"]')).toBeInViewport()
            expect((await geometry(page)).rootTop).toBe(0)
            // Exercise tail synchronization after older-history assertions so
            // its latest-page refresh cannot replace their message window.
            await page.getByRole('button', { name: 'Latest messages', exact: true }).click()
            await expect(page.getByText('Fixture message 1200', { exact: true })).toBeInViewport()
            expect((await geometry(page)).rootTop).toBe(0)
            // Existing fullscreen preview must retain viewport-relative sizing.
            const image = page.locator('[data-image-preview-trigger]').first()
            await image.evaluate(element => element.scrollIntoView({ block: 'center' }))
            await image.click()
            await expect(page.getByRole('dialog', { name: /image-.*\.svg/ })).toBeVisible()
            const dialogBox = await page.getByRole('dialog').boundingBox()
            expect(dialogBox?.height).toBe(after.viewportHeight)
            await page.getByRole('button', { name: 'Close', exact: true }).click()
            expect(errors).toEqual([])
        })
    })
}

// Regression: the outline jump is a smooth scroll, and media cards inside the
// already-rendered window settle asynchronously. The history anchor used to
// write scrollTop mid-animation, which cancels the smooth scroll and strands
// the reader between the old position and the row they picked. The jump must
// own the viewport until it lands.
test('outline jump is not interrupted by media settling above the target', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&navigationMedia=1')
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
    await page.waitForTimeout(2000)

    // Collapse the rows above the picked turn one frame after the jump starts,
    // the same layout change a media card finishing above the viewport makes.
    await page.evaluate(() => {
        const proto = Element.prototype
        const original = proto.scrollIntoView
        proto.scrollIntoView = function (...args: Parameters<Element['scrollIntoView']>) {
            const result = original.apply(this, args)
            const jumped = this
            requestAnimationFrame(() => {
                const chat = document.querySelector<HTMLElement>('.chat-scroll-y')
                if (!chat) return
                const targetTop = jumped.getBoundingClientRect().top
                for (const row of Array.from(
                    chat.querySelectorAll<HTMLElement>('.happy-thread-messages > [id]')
                )) {
                    if (row.getBoundingClientRect().bottom <= targetTop) {
                        row.style.display = 'none'
                    }
                }
            })
            return result
        }
    })

    await page.getByRole('button', { name: 'Open history', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 1010')
    await page.getByRole('button', { name: /Fixture message 1010/ }).click()
    await page.waitForTimeout(2000)

    const offset = await page.evaluate(() => {
        const chat = document.querySelector<HTMLElement>('.chat-scroll-y')
        const target = document.getElementById('hapi-message-user-text:m-1010')
        if (!chat || !target) return null
        return Math.round(target.getBoundingClientRect().top - chat.getBoundingClientRect().top)
    })
    expect(offset).not.toBeNull()
    // The row carries `scroll-mt-4` (16px), so a landing at the top is not 0.
    expect(offset as number).toBeGreaterThanOrEqual(-4)
    expect(offset as number).toBeLessThanOrEqual(28)
})

// Regression: a jumped-to history window can stop short of the session head.
// Reaching the end of that window is the end of the loaded page, not the end
// of the conversation; it must page the next messages forward. It used to
// switch to tail mode and replace the window, teleporting the reader to the
// newest message.
test('reading past a jumped history window pages forward instead of jumping to the end', async ({ page }) => {
    await page.goto('/e2e-fixtures/history-load-fixture.html?navigationShell=1&forwardPages=1')
    await expect(page.getByText('Fixture message 1200', { exact: true })).toBeVisible()
    await page.waitForTimeout(2000)

    // Pick a prompt outside the initial tail window: the hub returns a bounded
    // context window around it that still has newer rows below.
    await page.getByRole('button', { name: 'Open history', exact: true }).click()
    await page.getByRole('searchbox', { name: 'Search outline items' }).fill('Fixture message 600')
    await page.getByRole('button', { name: /Fixture message 600/ }).click()
    await expect(page.locator('[id="hapi-message-user-text:m-600"]')).toBeInViewport()
    await page.waitForTimeout(2000)
    expect(await page.evaluate(() => window.__probe.windowState().hasMoreNewer)).toBe(true)

    // Reach the end of the loaded window.
    await page.evaluate(() => {
        const chat = document.querySelector<HTMLElement>('.chat-scroll-y')
        if (chat) chat.scrollTop = chat.scrollHeight
    })

    await expect.poll(() => page.evaluate(
        () => window.__probe.requests.filter((request) => request.direction === 'after').length
    )).toBeGreaterThan(0)
    await page.waitForTimeout(1000)
    const state = await page.evaluate(() => window.__probe.windowState())
    expect(state.viewMode).toBe('history')
    expect(state.hasMoreNewer).toBe(true)
    // The tail window was not swapped in: the newest message stays unloaded.
    await expect(page.locator('[id="hapi-message-user-text:m-1200"]')).toHaveCount(0)
})
