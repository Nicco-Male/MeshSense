import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { dataDirectory } from './paths'
import { State } from './state'

const persistencePath = join(dataDirectory, 'state.json')

function loadState(): Record<string, unknown> {
  if (!existsSync(persistencePath)) return {}

  try {
    return JSON.parse(readFileSync(persistencePath, 'utf-8')) as Record<string, unknown>
  } catch (error) {
    console.warn(`Failed to parse persisted state at ${persistencePath}. Starting with an empty store.`, error)
    return {}
  }
}

let persistedState = loadState()

function saveState() {
  mkdirSync(dirname(persistencePath), { recursive: true })
  writeFileSync(persistencePath, JSON.stringify(persistedState, null, 2), 'utf-8')
}

export let store = persistedState

/** Return key-values as a `Record` object */
export function getAllKeyValues(): Record<string, unknown> {
  return { ...persistedState }
}

State.defaults = persistedState
State.subscribe(({ state }) => {
  if (state.flags.persist == true || state.flags.persist == 'api') {
    persistedState = { ...persistedState, [state.name]: state.value }
    store = persistedState
    saveState()
  }
})
