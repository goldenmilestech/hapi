/**
 * Configuration for hapi-hub (Direct Connect)
 *
 * Configuration is loaded with priority: environment variable > settings.json > default
 * When values are read from environment variables and not present in settings.json,
 * they are automatically saved for future use
 *
 * Optional environment variables:
 * - CLI_API_TOKEN: Shared secret for hapi CLI authentication (auto-generated if not set)
 * - HAPI_LEGACY_SHARED_TOKEN: Keep accepting CLI_API_TOKEN with an optional
 *   `:namespace` suffix (default: on). Set to `off` once every client uses a
 *   per-person access token.
 * - FEISHU_APP_ID / FEISHU_APP_SECRET: Enable Feishu OAuth login.
 * - FEISHU_REDIRECT_URI: OAuth redirect (default: {publicUrl}/auth/feishu).
 *   Must be registered in the Feishu app's security settings.
 * - FEISHU_SCOPE: Space-separated scopes (default: contact:user.email:readonly).
 * - FEISHU_OWNER_OPEN_ID / FEISHU_OWNER_EMAIL: Sign in as the hub owner
 *   (`default` namespace).
 * - FEISHU_VERIFICATION_TOKEN: Feishu event subscription verification token.
 *   Required to enable the hub bot (chat bridge).
 * - FEISHU_ENCRYPT_KEY: Optional Feishu event encryption key. When set, the
 *   hub decrypts event bodies and verifies the request signature.
 * - TELEGRAM_BOT_TOKEN: Telegram Bot API token from @BotFather
 * - TELEGRAM_NOTIFICATION: Enable/disable Telegram notifications (default: true)
 * - SERVERCHAN_SENDKEY: Server酱 SendKey/AppKey for push notifications
 * - SERVERCHAN_NOTIFICATION: Enable/disable Server酱 notifications (default: true)
 * - SERVERCHAN_BACKGROUND_ONLY: Only send Server酱 notifications without visible HAPI clients (default: false)
 * - HAPI_LISTEN_HOST: Host/IP to bind the HTTP service (default: 127.0.0.1)
 * - HAPI_LISTEN_PORT: Port for HTTP service (default: 3006)
 * - HAPI_PUBLIC_URL: Public URL for external access (e.g., Telegram Mini App)
 * - CORS_ORIGINS: Comma-separated CORS origins
 * - HAPI_RELAY_API: Relay API domain for tunwg (default: relay.hapi.run)
 * - HAPI_RELAY_AUTH: Relay auth key override (default: per-hub key issued by the relay)
 * - HAPI_RELAY_FORCE_TCP: Force TCP relay mode when UDP is unavailable (true/1)
 * - VAPID_SUBJECT: Contact email or URL for Web Push (defaults to mailto:admin@hapi.run)
 * - FCM_SERVICE_ACCOUNT_PATH: Firebase service-account JSON for Android push (settings: fcmServiceAccountPath;
 *   the project id comes from the JSON itself)
 * - HAPI_IOS_PUSH: iOS push transport apns|relay|off (default: relay; settings: iosPushMode)
 * - HAPI_ANDROID_PUSH: Android push transport auto|relay|fcm|off (default: auto; settings: androidPushMode)
 * - HAPI_PUSH_RELAY_URL: shared native push relay URL (settings: iosPushRelayUrl)
 * - APNS_KEY_P8_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID, APNS_ENV:
 *   direct-APNs credentials (settings: apnsKeyP8Path, apnsKeyId, apnsTeamId, apnsBundleId, apnsEnv)
 * - HAPI_HOME: Data directory (default: ~/.hapi)
 * - DB_PATH: SQLite database path (default: {HAPI_HOME}/hapi.db)
 */

import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getOrCreateCliApiToken } from './config/cliApiToken'
import { applyProviderCredentialsFromSettings } from './config/providerCredentials'
import { getSettingsFile } from './config/settings'
import { loadServerSettings, type ServerSettings, type ServerSettingsResult } from './config/serverSettings'

export type ConfigSource = 'env' | 'file' | 'default'

export interface ConfigSources {
    telegramBotToken: ConfigSource
    telegramNotification: ConfigSource
    serverChanSendKey: ConfigSource
    serverChanNotification: ConfigSource
    serverChanBackgroundOnly: ConfigSource
    listenHost: ConfigSource
    listenPort: ConfigSource
    publicUrl: ConfigSource
    corsOrigins: ConfigSource
    androidPushMode: ConfigSource
    fcmServiceAccountPath: ConfigSource
    iosPushMode: ConfigSource
    iosPushRelayUrl: ConfigSource
    apnsKeyP8Path: ConfigSource
    apnsKeyId: ConfigSource
    apnsTeamId: ConfigSource
    apnsBundleId: ConfigSource
    apnsEnv: ConfigSource
    cliApiToken: 'env' | 'file' | 'generated'
}

class Configuration {
    /** Telegram Bot API token */
    public readonly telegramBotToken: string | null

    /** Telegram bot enabled status (token present) */
    public readonly telegramEnabled: boolean

    /** Telegram notifications enabled */
    public readonly telegramNotification: boolean

    /** Server酱 SendKey/AppKey */
    public readonly serverChanSendKey: string | null

    /** Server酱 notifications enabled */
    public readonly serverChanNotification: boolean

    /** Only send Server酱 notifications when no visible HAPI client exists */
    public readonly serverChanBackgroundOnly: boolean

    /** CLI auth token (shared secret) */
    public cliApiToken: string

    /** Source of CLI API token */
    public cliApiTokenSource: 'env' | 'file' | 'generated' | ''

    /** Whether CLI API token was newly generated (for first-run display) */
    public cliApiTokenIsNew: boolean

    /**
     * Whether the legacy shared token grammar (`base[:namespace]`) still
     * authenticates. Defaults to on for backward compatibility; turn it off
     * with `HAPI_LEGACY_SHARED_TOKEN=off` after migrating every client to an
     * access token issued by the hub.
     */
    public readonly legacySharedTokenEnabled: boolean

    /** Feishu OAuth (web login). Disabled unless app id/secret/redirect exist. */
    public readonly feishuAppId: string | null
    public readonly feishuAppSecret: string | null
    public readonly feishuRedirectUri: string | null
    public readonly feishuScope: string
    public readonly feishuOwnerOpenId: string | null
    public readonly feishuOwnerEmail: string | null
    public readonly feishuEnabled: boolean
    /** Event subscription token; present only when the bot is configured. */
    public readonly feishuVerificationToken: string | null
    /** Optional AES key for encrypted Feishu event bodies. */
    public readonly feishuEncryptKey: string | null
    public readonly feishuBotEnabled: boolean

    /** Path to settings.json file */
    public readonly settingsFile: string

    /** Data directory for credentials and state */
    public readonly dataDir: string

    /** SQLite DB path */
    public readonly dbPath: string

    /** Port for the HTTP service */
    public readonly listenPort: number

    /** Host/IP to bind the HTTP service to */
    public readonly listenHost: string

    /** Public URL for external access (e.g., Telegram Mini App) */
    public readonly publicUrl: string

    /** Allowed CORS origins for Mini App + Socket.IO (comma-separated env override) */
    public readonly corsOrigins: string[]

    // Push delivery (FCM + iOS/APNs) — nullable strings interpreted by
    // fcm/fcmConfig.ts and push-ios/iosPushConfig.ts.
    public readonly androidPushMode: string | null
    public readonly fcmServiceAccountPath: string | null
    public readonly iosPushMode: string | null
    public readonly iosPushRelayUrl: string | null
    public readonly apnsKeyP8Path: string | null
    public readonly apnsKeyId: string | null
    public readonly apnsTeamId: string | null
    public readonly apnsBundleId: string | null
    public readonly apnsEnv: string | null

    /** Sources of each configuration value */
    public readonly sources: ConfigSources

    /** Private constructor - use createConfiguration() instead */
    private constructor(
        dataDir: string,
        dbPath: string,
        serverSettings: ServerSettings,
        sources: ServerSettingsResult['sources']
    ) {
        this.dataDir = dataDir
        this.dbPath = dbPath
        this.settingsFile = getSettingsFile(dataDir)

        // Apply server settings
        this.telegramBotToken = serverSettings.telegramBotToken
        this.telegramEnabled = Boolean(this.telegramBotToken)
        this.telegramNotification = serverSettings.telegramNotification
        this.serverChanSendKey = serverSettings.serverChanSendKey
        this.serverChanNotification = serverSettings.serverChanNotification
        this.serverChanBackgroundOnly = serverSettings.serverChanBackgroundOnly
        this.listenHost = serverSettings.listenHost
        this.listenPort = serverSettings.listenPort
        this.publicUrl = serverSettings.publicUrl
        this.corsOrigins = serverSettings.corsOrigins
        this.androidPushMode = serverSettings.androidPushMode
        this.fcmServiceAccountPath = serverSettings.fcmServiceAccountPath
        this.iosPushMode = serverSettings.iosPushMode
        this.iosPushRelayUrl = serverSettings.iosPushRelayUrl
        this.apnsKeyP8Path = serverSettings.apnsKeyP8Path
        this.apnsKeyId = serverSettings.apnsKeyId
        this.apnsTeamId = serverSettings.apnsTeamId
        this.apnsBundleId = serverSettings.apnsBundleId
        this.apnsEnv = serverSettings.apnsEnv

        // CLI API token - will be set by _setCliApiToken() before create() returns
        this.cliApiToken = ''
        this.cliApiTokenSource = ''
        this.cliApiTokenIsNew = false

        // Only an explicit false-like value disables the legacy path; unset or
        // any other value keeps it on so existing runners survive an upgrade.
        const legacyFlag = process.env.HAPI_LEGACY_SHARED_TOKEN?.trim().toLowerCase()
        this.legacySharedTokenEnabled = !(
            legacyFlag === '0'
            || legacyFlag === 'false'
            || legacyFlag === 'no'
            || legacyFlag === 'off'
        )

        // Feishu web login. The redirect must match the value registered in
        // the Feishu app; without one the flow cannot complete, so treat the
        // feature as disabled rather than failing at callback time.
        this.feishuAppId = process.env.FEISHU_APP_ID?.trim() || null
        this.feishuAppSecret = process.env.FEISHU_APP_SECRET?.trim() || null
        const redirectOverride = process.env.FEISHU_REDIRECT_URI?.trim() || null
        this.feishuRedirectUri = redirectOverride ?? (
            this.feishuAppId && this.feishuAppSecret
                ? `${this.publicUrl.replace(/\/+$/, '')}/auth/feishu`
                : null
        )
        this.feishuScope = process.env.FEISHU_SCOPE?.trim() || 'contact:user.email:readonly'
        this.feishuOwnerOpenId = process.env.FEISHU_OWNER_OPEN_ID?.trim() || null
        this.feishuOwnerEmail = process.env.FEISHU_OWNER_EMAIL?.trim().toLowerCase() || null
        this.feishuEnabled = Boolean(this.feishuAppId && this.feishuAppSecret && this.feishuRedirectUri)
        this.feishuVerificationToken = process.env.FEISHU_VERIFICATION_TOKEN?.trim() || null
        this.feishuEncryptKey = process.env.FEISHU_ENCRYPT_KEY?.trim() || null
        // The bot reuses the login app credentials; the verification token is
        // what makes the public event endpoint meaningful.
        this.feishuBotEnabled = Boolean(
            this.feishuAppId && this.feishuAppSecret && this.feishuVerificationToken
        )

        // Store sources for logging (cliApiToken will be set by _setCliApiToken)
        this.sources = {
            ...sources,
        } as ConfigSources

        // Ensure data directory exists
        if (!existsSync(this.dataDir)) {
            mkdirSync(this.dataDir, { recursive: true })
        }
    }

    /** Create configuration asynchronously */
    static async create(): Promise<Configuration> {
        // 1. Determine data directory (env only - not persisted)
        const dataDir = process.env.HAPI_HOME
            ? process.env.HAPI_HOME.replace(/^~/, homedir())
            : join(homedir(), '.hapi')

        // Ensure data directory exists before loading settings
        if (!existsSync(dataDir)) {
            mkdirSync(dataDir, { recursive: true })
        }

        // 2. Determine DB path (env only - not persisted)
        const dbPath = process.env.DB_PATH
            ? process.env.DB_PATH.replace(/^~/, homedir())
            : join(dataDir, 'hapi.db')

        // 3. Load hub settings (with persistence)
        const settingsResult = await loadServerSettings(dataDir)

        if (settingsResult.savedToFile) {
            console.log(`[Hub] Configuration saved to ${getSettingsFile(dataDir)}`)
        }

        // 3b. Apply Settings-managed provider credentials into process.env
        // (env vars set at process start still win; no restart needed for UI saves)
        await applyProviderCredentialsFromSettings(dataDir)

        // 4. Create configuration instance
        const config = new Configuration(
            dataDir,
            dbPath,
            settingsResult.settings,
            settingsResult.sources
        )

        // 5. Load CLI API token
        const tokenResult = await getOrCreateCliApiToken(dataDir)
        config._setCliApiToken(tokenResult.token, tokenResult.source, tokenResult.isNew)

        return config
    }

    /** Set CLI API token (called during async initialization) */
    _setCliApiToken(token: string, source: 'env' | 'file' | 'generated', isNew: boolean): void {
        this.cliApiToken = token
        this.cliApiTokenSource = source
        this.cliApiTokenIsNew = isNew
        ;(this.sources as { cliApiToken: string }).cliApiToken = source
    }
}

// Singleton instance (set by createConfiguration)
let _configuration: Configuration | null = null

/**
 * Create and initialize configuration asynchronously.
 * Must be called once at startup before getConfiguration() can be used.
 */
export async function createConfiguration(): Promise<Configuration> {
    if (_configuration) {
        return _configuration
    }
    _configuration = await Configuration.create()
    return _configuration
}

/**
 * Get the initialized configuration.
 * Throws if createConfiguration() has not been called yet.
 */
export function getConfiguration(): Configuration {
    if (!_configuration) {
        throw new Error('Configuration not initialized. Call createConfiguration() first.')
    }
    return _configuration
}
