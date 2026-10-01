import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

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

export default class DriftSync extends Command {
  static description =
    'Propose a sync plan for drifted metadata. Planning only, application stays operator run.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --type ApexClass --name AccountHelper --source-credential-id a11 --source-org-id 00D --target-credential-id a22 --target-org-id 00E',
    '<%= config.bin %> <%= command.id %> --type ApexClass --name AccountHelper --source-credential-id a11 --source-org-id 00D --target-credential-id a22 --target-org-id 00E --direction source --yes --json',
  ]

  static flags = {
    type: Flags.string({char: 't', description: 'Metadata type, for example ApexClass.', required: true}),
    name: Flags.string({char: 'n', description: 'Metadata API name.', required: true}),
    'source-credential-id': Flags.string({description: 'Source org credential ID.', required: true}),
    'source-org-id': Flags.string({description: 'Source org ID.', required: true}),
    'target-credential-id': Flags.string({description: 'Target org credential ID.', required: true}),
    'target-org-id': Flags.string({description: 'Target org ID.', required: true}),
    'pipeline-id': Flags.string({description: 'Pipeline ID scoping gateway calls.'}),
    direction: Flags.string({description: 'Winning side for the sync plan.', options: ['source', 'target']}),
    yes: Flags.boolean({char: 'y', description: 'Acknowledge the plan and reveal apply steps.', default: false}),
    'ai-explain': Flags.boolean({description: 'Ask the operate agent to narrate the plan. Off by default.', default: false}),
    json: Flags.boolean({description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(DriftSync)
    const type = flags.type as string
    const name = flags.name as string
    const sCred = flags['source-credential-id'] as string
    const sOrg = flags['source-org-id'] as string
    const tCred = flags['target-credential-id'] as string
    const tOrg = flags['target-org-id'] as string
    const pipeline = (flags['pipeline-id'] as string | undefined) ?? null
    const direction = (flags.direction as 'source' | 'target' | undefined) ?? null
    const confirmed = (flags.yes as boolean) ?? false
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
      const detail = 'One side returned no comparable content. No plan can be proposed.'
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const diff = sourceText === targetText ? {added: 0, removed: 0} : diffLines(sourceText, targetText)
    if (diff.added === 0 && diff.removed === 0) {
      const payload = {status: 'identical', type, name, plan: null as string[] | null}
      if (asJson) this.log(JSON.stringify(payload, null, 2))
      else this.log(`No drift: ${type} ${name} is identical on both ends. Nothing to sync.`)
      return
    }

    const plan = direction === 'source'
      ? [
          `Retrieve ${type} ${name} from the source org.`,
          'Review the retrieved content against the target copy.',
          'Deploy it to the target through the normal promotion flow.',
          'Re-run drift check to confirm identical.',
        ]
      : direction === 'target'
        ? [
            `Retrieve ${type} ${name} from the target org.`,
            'Review the retrieved content against the source copy.',
            'Commit it back through the normal development flow.',
            'Re-run drift check to confirm identical.',
          ]
        : [
            'Choose the winning side explicitly with --direction source or --direction target.',
            'The plan unlocks once the direction is declared. Nothing is proposed blindly.',
          ]

    let aiNarration: string | null = null
    if (explain) {
      const prompt =
        `Explain this metadata sync plan in 3 sentences for a Salesforce developer. ` +
        `Type ${type}, member ${name}, +${diff.added} -${diff.removed} lines differ, ` +
        `direction ${direction ?? 'undecided'}.`
      try {
        const out = runAgentia(['ai', 'agent', 'ask', '-p', prompt, '--agent', 'operate', '--json'], AI_TIMEOUT_MS)
        let parsed: unknown
        try {
          parsed = JSON.parse(out)
        } catch {
          parsed = out
        }
        aiNarration = findAgentText(parsed)
      } catch {
        aiNarration = null
      }
    }

    const applyRevealed = direction !== null && confirmed
    const payload = {
      status: 'drifted',
      type,
      name,
      added: diff.added,
      removed: diff.removed,
      direction,
      plan,
      applyRevealed,
      applySteps: applyRevealed ? plan : null,
      aiExplainEnabled: explain,
      aiNarration,
    }
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else {
      this.log(`Drifted: ${type} ${name} (+${diff.added} -${diff.removed}). Sync plan:`)
      for (const step of plan) this.log(`- ${step}`)
      if (!direction) this.log('Re-run with --direction source|target to unlock the apply runbook.');
      else if (!confirmed) this.log('Re-run with --yes to reveal the apply runbook. Application itself stays operator run.');
      if (aiNarration) this.log(`AI narration: ${aiNarration}`)
    }
  }
}
