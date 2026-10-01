import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join, resolve} from 'node:path'

function runAgentia(args: string[], timeoutMs = 120_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
}

function baseDir(): string {
  return join(homedir(), '.agentia-env-drift', 'baselines')
}

function safeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'baseline'
}

function extractContent(parsed: any): string | null {
  if (parsed == null) return null
  if (typeof parsed === 'string') return parsed
  const root = parsed?.result ?? parsed
  if (typeof root === 'string') return root
  if (typeof root !== 'object') return null
  for (const key of ['content', 'file', 'body', 'data', 'xml', 'source']) {
    const v = (root as Record<string, unknown>)[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  const inner = (root as Record<string, unknown>)['result']
  if (typeof inner === 'string' && inner.trim() !== '') return inner
  return null
}

function diffLines(before: string, after: string): {added: number; removed: number} {
  const counts = new Map<string, number>()
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1)
  let added = 0
  for (const line of after.split('\n')) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else added += 1
  }
  let removed = 0
  for (const left of counts.values()) removed += left
  return {added, removed}
}

export default class DriftBaseline extends Command {
  static description =
    'Save, list and diff named content baselines. Makes drift checks production useful.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --save release-1 --type ApexClass --name AccountHelper --source-credential-id a11 --source-org-id 00D',
    '<%= config.bin %> <%= command.id %> --save release-1 --content-file ./AccountHelper.cls',
    '<%= config.bin %> <%= command.id %> --list',
    '<%= config.bin %> <%= command.id %> --diff release-1 --source-credential-id a11 --source-org-id 00D',
  ]

  static flags = {
    save: Flags.string({description: 'Baseline name to save.'}),
    list: Flags.boolean({description: 'List saved baselines.', default: false}),
    diff: Flags.string({description: 'Baseline name to compare live content against.'}),
    type: Flags.string({char: 't', description: 'Metadata type for live fetch.'}),
    name: Flags.string({char: 'n', description: 'Metadata API name for live fetch.'}),
    'source-credential-id': Flags.string({description: 'Org credential ID for live fetch.'}),
    'source-org-id': Flags.string({description: 'Org ID for live fetch.'}),
    'pipeline-id': Flags.string({description: 'Pipeline ID scoping gateway calls.'}),
    'content-file': Flags.string({description: 'Local file to baseline instead of fetching.'}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(DriftBaseline)
    const save = (flags.save as string | undefined) ?? null
    const list = (flags.list as boolean) ?? false
    const diffName = (flags.diff as string | undefined) ?? null
    const asJson = (flags.json as boolean) ?? false
    mkdirSync(baseDir(), {recursive: true})

    if (list) {
      let files: string[] = []
      try {
        files = readdirSync(baseDir()).filter((f) => f.endsWith('.json'))
      } catch {
        files = []
      }
      const items = files.map((f) => {
        try {
          const rec: any = JSON.parse(readFileSync(join(baseDir(), f), 'utf8'))
          return {name: rec?.name ?? f, type: rec?.type ?? '?', member: rec?.member ?? '?', createdAt: rec?.createdAt ?? '?'}
        } catch {
          return {name: f, type: '?', member: '?', createdAt: '?'}
        }
      })
      if (asJson) this.log(JSON.stringify({baselines: items}, null, 2))
      else if (items.length === 0) this.log('No baselines saved. Capture one with --save first.')
      else for (const i of items) this.log(`- ${i.name}: ${i.type} ${i.member}, captured ${i.createdAt}.`)
      return
    }

    if (save) {
      const contentFile = (flags['content-file'] as string | undefined) ?? null
      const type = (flags.type as string | undefined) ?? null
      const name = (flags.name as string | undefined) ?? null
      let content: string | null = null
      if (contentFile) {
        try {
          content = readFileSync(resolve(process.cwd(), contentFile), 'utf8')
        } catch (error: any) {
          const detail = `Could not read content file: ${(error?.message ?? String(error)).split('\n')[0]}`
          if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
          else this.log(detail)
          this.exit(1)
        }
      } else {
        const sCred = flags['source-credential-id'] as string | undefined
        const sOrg = flags['source-org-id'] as string | undefined
        const pipeline = flags['pipeline-id'] as string | undefined
        if (!type || !name || !sCred || !sOrg) {
          const detail = 'Saving needs --type plus --name plus credential and org IDs, or --content-file for offline capture.'
          if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
          else this.log(detail)
          this.exit(1)
        }
        try {
          const args = ['cicd', 'metadata', 'content', 'get', '--api-name', name, '--metadata-type', type,
            '--source-credential-id', sCred, '--source-org-id', sOrg, '--json']
          if (pipeline) args.push('--pipeline-id', pipeline)
          content = extractContent(JSON.parse(runAgentia(args)))
        } catch (error: any) {
          const detail = `Baseline fetch failed: ${(error?.message ?? String(error)).split('\n')[0]}`
          if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
          else this.log(detail)
          this.exit(1)
        }
      }
      if (!content || content.trim() === '') {
        const detail = 'Fetched content came back empty. Baseline not saved.'
        if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
        else this.log(detail)
        this.exit(1)
      }
      const record = {
        name: safeName(save),
        type: type ?? 'file',
        member: name ?? (contentFile as string),
        createdAt: new Date().toISOString(),
        chars: (content as string).length,
        content,
      }
      const path = join(baseDir(), `${record.name}.json`)
      writeFileSync(path, JSON.stringify(record), 'utf8')
      if (asJson) {
        this.log(JSON.stringify({status: 'saved', baseline: record.name, chars: record.chars, file: path}, null, 2))
      } else {
        this.log(`Baseline ${record.name} saved: ${(content as string).length} chars from ${record.member}.`)
      }
      return
    }

    if (diffName) {
      const sCred = flags['source-credential-id'] as string | undefined
      const sOrg = flags['source-org-id'] as string | undefined
      const pipeline = flags['pipeline-id'] as string | undefined
      const type = flags.type as string | undefined
      const name = flags.name as string | undefined
      if (!sCred || !sOrg || !type || !name) {
        const detail = 'Diff needs --type plus --name plus credential and org IDs to fetch live content.'
        if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
        else this.log(detail)
        this.exit(1)
      }
      let record: any = null
      try {
        record = JSON.parse(readFileSync(join(baseDir(), `${safeName(diffName)}.json`), 'utf8'))
      } catch {
        const detail = `Baseline ${diffName} not found. List with --list first.`
        if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
        else this.log(detail)
        this.exit(1)
      }
      let live: string | null = null
      try {
        const args = ['cicd', 'metadata', 'content', 'get', '--api-name', name, '--metadata-type', type,
          '--source-credential-id', sCred, '--source-org-id', sOrg, '--json']
        if (pipeline) args.push('--pipeline-id', pipeline)
        live = extractContent(JSON.parse(runAgentia(args)))
      } catch (error: any) {
        const detail = `Live fetch failed: ${(error?.message ?? String(error)).split('\n')[0]}`
        if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
        else this.log(detail)
        this.exit(1)
      }
      if (!live) {
        const detail = 'Live content came back empty.'
        if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
        else this.log(detail)
        this.exit(1)
      }
      const d = diffLines(str(record?.content), live)
      const drifted = d.added > 0 || d.removed > 0
      const payload = {status: drifted ? 'drifted' : 'identical', baseline: safeName(diffName), added: d.added, removed: d.removed}
      if (asJson) {
        this.log(JSON.stringify(payload, null, 2))
      } else {
        this.log(drifted
          ? `Drifted versus baseline ${safeName(diffName)}: +${d.added} -${d.removed}.`
          : `Identical to baseline ${safeName(diffName)}. Safe to proceed.`)
      }
      return
    }

    const detail = 'Pass --save to capture, --list to browse, or --diff to compare.'
    if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
    else this.log(detail)
    this.exit(1)
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}
