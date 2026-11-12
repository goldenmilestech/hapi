import chalk from 'chalk'
import { runUpdate, type UpdateOptions } from '@/update/runUpdate'
import type { CommandDefinition } from './types'

export const UPDATE_HELP = `hapi update [options]

Update the installed hapi CLI/runner from the fork's GitHub releases.

Options:
  --check          Show the installed and latest versions without changing anything
  --tag <tag>      Install a specific cli-* release
  --force          Reinstall even when already up to date
  --bin <path>     Update this binary instead of the running one
  --keep <n>       Keep n backups (default 3)
  --no-wait        Do not wait for the runner to self-restart
  -h, --help       Show this help

Environment:
  HAPI_UPDATE_REPO        GitHub repo to read releases from
                          (default qlqj-frederick-dong/hapi)
  HAPI_AUTO_UPDATE=1      Let the runner check for updates every ~6 hours
  HAPI_DISABLE_VERSION_HANDOFF=1
                          Do not wait for the runner to restart itself
`

function takeValue(args: string[], index: number, flag: string): { value: string; consumed: number } {
    const arg = args[index]
    const equalsAt = arg.indexOf('=')
    if (equalsAt !== -1) {
        return { value: arg.slice(equalsAt + 1), consumed: 1 }
    }
    const next = args[index + 1]
    if (next === undefined || next.startsWith('--')) {
        throw new Error(`${flag} requires a value`)
    }
    return { value: next, consumed: 2 }
}

export function parseUpdateArgs(args: string[]): UpdateOptions | null {
    const options: UpdateOptions = {
        check: false,
        force: false,
        tag: null,
        keep: 3,
        wait: true,
        bin: null
    }

    for (let index = 0; index < args.length;) {
        const arg = args[index]
        if (arg === '-h' || arg === '--help' || arg === 'help') {
            return null
        }
        if (arg === '--check') {
            options.check = true
            index += 1
            continue
        }
        if (arg === '--force') {
            options.force = true
            index += 1
            continue
        }
        if (arg === '--no-wait') {
            options.wait = false
            index += 1
            continue
        }
        if (arg === '--tag' || arg.startsWith('--tag=')) {
            const { value, consumed } = takeValue(args, index, '--tag')
            if (!value.trim()) {
                throw new Error('--tag requires a value')
            }
            options.tag = value.trim()
            index += consumed
            continue
        }
        if (arg === '--keep' || arg.startsWith('--keep=')) {
            const { value, consumed } = takeValue(args, index, '--keep')
            const keep = Number(value)
            if (!Number.isInteger(keep) || keep < 0) {
                throw new Error('--keep must be a non-negative integer')
            }
            options.keep = keep
            index += consumed
            continue
        }
        if (arg === '--bin' || arg.startsWith('--bin=')) {
            const { value, consumed } = takeValue(args, index, '--bin')
            if (!value.trim()) {
                throw new Error('--bin requires a path')
            }
            options.bin = value.trim()
            index += consumed
            continue
        }
        throw new Error(`Unknown option: ${arg}`)
    }

    return options
}

export async function handleUpdateCommand(args: string[]): Promise<number> {
    const options = parseUpdateArgs(args)
    if (!options) {
        console.log(UPDATE_HELP)
        return 0
    }
    return await runUpdate(options)
}

export const updateCommand: CommandDefinition = {
    name: 'update',
    requiresRuntimeAssets: false,
    run: async ({ commandArgs }) => {
        try {
            const exitCode = await handleUpdateCommand(commandArgs)
            if (exitCode !== 0) {
                process.exit(exitCode)
            }
        } catch (error) {
            console.error(chalk.red(`Update failed: ${error instanceof Error ? error.message : String(error)}`))
            process.exit(1)
        }
    }
}
