import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'

const AI_TIMEOUT_MS = 120_000

function runAgentia(args: string[], timeoutMs = 120_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe']})
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

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export default class DriftReport extends Command {
  static description =
    'Write a cron friendly HTML drift summary for email style review. Read only on both orgs.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --type ApexClass --name AccountHelper --source-credential-id a11 --source-org-id 00D --target-credential-id a22 --target-org-id 00E',
    '<%= config.bin %> <%= command.id %> --type ApexClass --name AccountHelper --source-credential-id a11 --source-org-id 00D --target-credential-id a22 --target-org-id 00E --ai-explain --json',
  ]

  static flags = {
    type: Flags.string({char: 't', description: 'Metadata type, for example ApexClass.', required: true}),
    name: Flags.string({char: 'n', description: 'Metadata API name.', required: true}),
    'source-credential-id': Flags.string({description: 'Source org credential ID.', required: true}),
    'source-org-id': Flags.string({description: 'Source org ID.', required: true}),
    'target-credential-id': Flags.string({description: 'Target org credential ID.', required: true}),
    'target-org-id': Flags.string({description: 'Target org ID.', required: true}),
    'pipeline-id': Flags.string({description: 'Pipeline ID scoping gateway calls.'}),
    output: Flags.string({char: 'o', description: 'HTML report file path.'}),
    'ai-explain': Flags.boolean({description: 'Ask the operate agent for an impact paragraph. Off by default.', default: false}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(DriftReport)
    const type = flags.type as string
    const name = flags.name as string
    const sCred = flags['source-credential-id'] as string
    const sOrg = flags['source-org-id'] as string
    const tCred = flags['target-credential-id'] as string
    const tOrg = flags['target-org-id'] as string
    const pipeline = (flags['pipeline-id'] as string | undefined) ?? null
    const explain = (flags['ai-explain'] as boolean) ?? false
    const asJson = (flags.json as boolean) ?? false

    const fetchArgs = (cred: string, org: string): string[] => {
      const args = ['cicd', 'metadata', 'content', 'get', '--api-name', name, '--metadata-type', type,
        '--source-credential-id', cred, '--source-org-id', org, '--json']
      if (pipeline) args.push('--pipeline-id', pipeline)
      return args
    }

    const errors: string[] = []
    let sourceText: string | null = null
    let targetText: string | null = null
    try {
      sourceText = extractContent(JSON.parse(runAgentia(fetchArgs(sCred, sOrg))))
    } catch (error: any) {
      errors.push(`Source fetch failed: ${(error?.message ?? String(error)).split('\n')[0]}`)
    }
    try {
      targetText = extractContent(JSON.parse(runAgentia(fetchArgs(tCred, tOrg))))
    } catch (error: any) {
      errors.push(`Target fetch failed: ${(error?.message ?? String(error)).split('\n')[0]}`)
    }
    if (!sourceText || !targetText) {
      const detail = errors.join(' ') || 'One side returned no comparable content.'
      if (asJson) this.log(JSON.stringify({status: 'error', type, name, detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const a = (sourceText as string).split('\n')
    const b = (targetText as string).split('\n')
    const counts = new Map<string, number>()
    for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
    let added = 0
    for (const line of b) {
      const left = counts.get(line) ?? 0
      if (left > 0) counts.set(line, left - 1)
      else added += 1
    }
    let removed = 0
    for (const left of counts.values()) removed += left
    const drifted = added > 0 || removed > 0

    let aiParagraph: string | null = null
    if (drifted && explain) {
      try {
        const out = runAgentia(['ai', 'agent', 'ask', '-p',
          `Explain this metadata drift in 3 sentences for a release manager. Type ${type}, member ${name}, +${added} -${removed} lines differ.`,
          '--agent', 'operate', '--json'], AI_TIMEOUT_MS)
        let parsed: unknown
        try {
          parsed = JSON.parse(out)
        } catch {
          parsed = out
        }
        const rec = (n: unknown, d = 0): string | null => {
          if (n == null || d > 3) return null
          if (typeof n === 'string') return n.trim() !== '' ? n.trim().slice(0, 1500) : null
          if (typeof n === 'object' && !Array.isArray(n)) {
            const o = n as Record<string, unknown>
            for (const k of ['response', 'text', 'answer', 'message', 'content', 'summary']) {
              if (typeof o[k] === 'string' && (o[k] as string).trim() !== '') return (o[k] as string).trim().slice(0, 1500)
            }
            if ('result' in o) return rec(o['result'], d + 1)
          }
          return null
        }
        aiParagraph = rec(parsed)
      } catch {
        aiParagraph = null
      }
    }

    const stamp = new Date().toISOString()
    const banner = drifted ? 'DRIFT DETECTED' : 'IDENTICAL'
    const bannerColor = drifted ? '#B00020' : '#1B7A3D'
    const file = resolve(process.cwd(),
      (flags.output as string | undefined) ?? `./drift-${type}-${name}-${stamp.slice(0, 10)}.html`)
    const html =
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Drift report ${escHtml(type)} ${escHtml(name)}</title>` +
      `<style>body{font-family:sans-serif;margin:2rem;color:#111}.banner{padding:.8rem;font-weight:bold;color:#fff;background:${bannerColor}}</style></head><body>` +
      `<div class="banner">${banner}: ${escHtml(type)} ${escHtml(name)}</div>` +
      `<p>Generated ${stamp} by agentia drift report. Added lines: ${added}. Removed lines: ${removed}.</p>` +
      (aiParagraph ? `<h2>Impact</h2><p>${escHtml(aiParagraph)}</p>` : `<p>Promote only after reviewing the drift above.</p>`) +
      `</body></html>`
    writeFileSync(file, html, 'utf8')

    const payload = {status: drifted ? 'drifted' : 'identical', type, name, added, removed, file, aiExplainEnabled: explain, aiParagraph}
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`${banner}: ${type} ${name} (+${added} -${removed}). Report written to ${file}.`)
    }
  }
}
