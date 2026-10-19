// Dry run against a real card library: drives the plugin's actual apply() with
// a stub host, a temporary DSH_HOME, and three agents covering every branch of
// the resolution order.
//
//   node scripts/dryrun.mjs
//
// Nothing here touches the live ~/.dsh; DSH_HOME is pointed at a temp directory
// built from cards/ on every run.

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoCards = join(here, '..', 'cards')
const CARD_FILES = ['terse-reviewer.dshcd', 'patient-teacher.dshcd', 'grumpy-veteran.dshcd']

const home = mkdtempSync(join(tmpdir(), 'dshcd-dryrun-'))
const cardsDir = join(home, 'character-cards')
mkdirSync(cardsDir, { recursive: true })
for (const name of CARD_FILES) cpSync(join(repoCards, name), join(cardsDir, name))
writeFileSync(join(cardsDir, 'default'), 'terse-reviewer\n')
writeFileSync(
  join(cardsDir, 'sessions.json'),
  JSON.stringify({ 'session-override': 'patient-teacher', 'session-legacy-budget': 'legacy-budget' }, null, 2),
)

// A card carrying a legacy `budget` key from before D11. Its maxTokens is far
// below what the card renders to, which is the point: the key is now an unknown
// field, so the card has to come out whole and the key has to survive untouched.
const legacy = JSON.parse(readFileSync(join(repoCards, 'terse-reviewer.dshcd'), 'utf8'))
legacy.id = 'legacy-budget'
legacy.name = '带旧预算字段的卡'
legacy.budget = { maxTokens: 50 }
writeFileSync(join(cardsDir, 'legacy-budget.dshcd'), JSON.stringify(legacy, null, 2))

// CARDS_DIR is computed when the module is evaluated, so this must be set first.
process.env.DSH_HOME = home
const { apply } = await import('../src/index.js')
const { renderCard } = await import('../src/cards.js')

const listeners = []
const warnings = []

/** Minimal Context stand-in covering the surface apply() and bindCard() use. */
const ctx = {
  get: (name) => (name === 'agents' ? { list: () => [] } : undefined),
  inject: (deps, callback) => {
    if (deps.includes('agents')) callback({ agents: { list: () => [] } })
  },
  on: (event, listener) => {
    if (event === 'agent/created') listeners.push(listener)
  },
  logger: {
    warn: (message) => warnings.push(message),
    info: () => {},
  },
}

apply(ctx)

if (listeners.length === 0) {
  console.error('FAIL: no agent/created listener was registered')
  process.exit(1)
}

/** One agent whose systemPrompt capture records whatever gets registered. */
function makeAgent(id) {
  const agent = { id, captured: undefined, order: undefined }
  agent.ctx = {
    // bindCard() waits for systemPrompt inside the agent scope rather than
    // naming it directly; the stub resolves it the moment inject() is called.
    inject: (deps, callback) => {
      callback({
        systemPrompt: {
          // Mirrors the installed 0.2.x runtime: the checkout's
          // DEPLOYMENT_PERSONA name is unknown there, and getSectionOrder
          // answers an unknown name with undefined rather than throwing.
          getSectionOrder: (name) => ({ DEPLOYMENT_PERSONA_PREFIX: 0, PLAN_POLICY: 500 })[name],
          section: (section) => {
            agent.captured = section
            agent.order = section.order
            return () => {}
          },
        },
      })
      return { dispose: () => {} }
    },
  }
  return agent
}

const cases = [
  ['session-override', 'session override wins over the default pointer'],
  ['session-default', 'no override -> default pointer (terse-reviewer)'],
  ['session-legacy-budget', 'a legacy budget key changes nothing - the card renders whole (D11)'],
]

const agents = cases.map(([id]) => makeAgent(id))
for (const agent of agents) for (const listener of listeners) listener({ agent })

// D11: a card's declared `budget` must not shorten anything. The same card with
// the key removed has to bind to exactly the same text - if the legacy key were
// still honoured, this is where it would show up.
const bare = { ...legacy }
delete bare.budget
const bound = agents[2].captured
if (bound === undefined || bound.text !== renderCard(bare)) {
  console.error('FAIL: a card carrying a legacy budget key was not rendered whole')
  process.exit(1)
}

console.log(`cards dir: ${cardsDir}\n`)
console.log('id'.padEnd(18), 'resolved'.padEnd(18), 'order'.padEnd(6), 'tokens')
console.log('-'.repeat(58))
for (const [index, agent] of agents.entries()) {
  const [, note] = cases[index]
  const tokens = agent.captured === undefined ? '-' : `${Math.ceil(agent.captured.text.length / 3)}`
  console.log(agent.id.padEnd(18), (agent.captured === undefined ? 'NONE' : 'bound').padEnd(18), String(agent.order).padEnd(6), tokens)
  console.log('  '.repeat(9) + note)
}

const sample = agents.find(agent => agent.captured !== undefined)
if (sample !== undefined) {
  console.log('\n=== section text bound to the first agent ===')
  console.log(`name  : ${sample.captured.name}`)
  console.log(`order : ${sample.captured.order}`)
  console.log(sample.captured.text)
}

if (warnings.length > 0) {
  console.log('\n=== warnings ===')
  for (const warning of warnings) console.log(`  ${warning}`)
}
