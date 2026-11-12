/**
 * Reads the `ns` claim from a hub JWT. The token is already held by this
 * client; this is a UI hint, never an authorization decision.
 */
export function getNamespaceFromToken(token: string): string | null {
    try {
        const payload = token.split('.')[1]
        if (!payload) {
            return null
        }
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
        const decoded = JSON.parse(atob(base64)) as { ns?: unknown }
        return typeof decoded.ns === 'string' ? decoded.ns : null
    } catch {
        return null
    }
}
