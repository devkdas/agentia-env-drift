import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

const AI_TIMEOUT_MS = 120_000
const DIFF_LINE_CAP = 400
const DIFF_CHAR_CAP = 12000

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

interface Hunk {
  kind: 'added' | 'removed'
  line: string
}

function diffLines(before: string, after: string): {added: number; removed: number; hunks: Hunk[]} {
  const a = before.split('\n')
  const b = after.split('\n')
  const counts = new Map<string, number>()
  for (const line of a) counts.set(line, (counts.get(line) ?? 0) + 1)
  const hunks: Hunk[] = []
  let added = 0
  for (const line of b) {
    const left = counts.get(line) ?? 0
    if (left > 0) counts.set(line, left - 1)
    else {
      added += 1
      if (hunks.length < DIFF_LINE_CAP) hunks.push({kind: 'added', line: line.slice(0, 300)})
    }
  }
  let removed = 0
  for (const [line, left] of counts) {
    for (let i = 0; i < left; i += 1) {
      removed += 1
      if (hunks.length < DIFF_LINE_CAP) hunks.push({kind: 'removed', line: line.slice(0, 300)})
    }
  }
  return {added, removed, hunks}
}

function findAgentText(node: unknown, depth = 0): string | null {
  if (node == null || depth > 3) return null
  if (typeof node === 'string') return node.trim() !== '' ? node.trim().slice(0, 2000) : null
  if (typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>
    for (const key of ['response', 'text', 'answer', 'message', 'content', 'output', 'summary']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 2000)
    }
    if ('result' in obj) return findAgentText(obj['result'], depth + 1)
  }
  return null
}

export default class DriftCheck extends Command {
  static description =
    'Detect metadata drift between two environments. Read only, never writes to either org.'

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
    'pipeline-id': Flags.string({description: 'Pipeline ID scoping the gateway calls.'}),
    'ai-explain': Flags.boolean({description: 'Ask the operate agent to explain the impact. Off by default.', default: false}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(DriftCheck)
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

    let sourceText: string | null = null
    let targetText: string | null = null
    try {
      sourceText = extractContent(JSON.parse(runAgentia(fetchArgs(sCred, sOrg))))
    } catch (error: any) {
      const detail = `Source fetch failed: ${(error?.message ?? String(error)).split('\n')[0]}`
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }
    try {
      targetText = extractContent(JSON.parse(runAgentia(fetchArgs(tCred, tOrg))))
    } catch (error: any) {
      const detail = `Target fetch failed: ${(error?.message ?? String(error)).split('\n')[0]}`
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    if (sourceText == null || targetText == null) {
      const detail = 'One side returned no comparable content. Cannot determine drift.'
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const diff = sourceText === targetText
      ? {added: 0, removed: 0, hunks: [] as Hunk[]}
      : diffLines(sourceText, targetText)
    const drifted = diff.added > 0 || diff.removed > 0

    let aiExplanation: string | null = null
    if (drifted && explain) {
      const hunkText = diff.hunks.map((h) => `${h.kind === 'added' ? '+' : '-'} ${h.line}`).join('\n').slice(0, DIFF_CHAR_CAP)
      const prompt =
        `Explain this Salesforce metadata drift and how it can impact deployments in 3 sentences. ` +
        `Type ${type}, member ${name}. Diff (+ target only, - source only):\n${hunkText}`
      try {
        const out = runAgentia(['ai', 'agent', 'ask', '-p', prompt, '--agent', 'operate', '--json'], AI_TIMEOUT_MS)
        let parsed: unknown
        try {
          parsed = JSON.parse(out)
        } catch {
          parsed = out
        }
        aiExplanation = findAgentText(parsed)
      } catch {
        aiExplanation = null
      }
    }

    const payload = {
      status: drifted ? 'drifted' : 'identical',
      type,
      name,
      added: diff.added,
      removed: diff.removed,
      hunks: diff.hunks.slice(0, 40),
      aiExplainEnabled: explain,
      aiExplanation,
    }
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else if (!drifted) {
      this.log(`No drift: ${type} ${name} is identical on both ends. Safe to proceed.`)
    } else {
      this.log(`Drift detected: ${type} ${name} differs (+${diff.added} -${diff.removed}). Review before promoting.`)
      for (const h of diff.hunks.slice(0, 10)) this.log(`  ${h.kind === 'added' ? '+' : '-'} ${h.line}`)
      if (aiExplanation) this.log(`AI explanation: ${aiExplanation}`)
      else if (explain) this.log('AI explanation unavailable. Raw diff above still stands.')
    }
  }
}
