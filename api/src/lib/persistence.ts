import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { dataDirectory } from './paths'
import { State } from './state'

const persistencePath = join(dataDirectory, 'state.json')

type StoreFn = ((key: string, value?: unknown) => unknown) &
  Record<string, unknown> & {
    '/': string[]
  }

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

function createStore(): StoreFn {
  const fn = (function (key: string, value?: unknown) {
    if (arguments.length === 2) {
      persistedState = { ...persistedState, [key]: value }
      saveState()
      return value
    }

    return persistedState[key]
  }) as StoreFn

  return new Proxy(fn, {
    get(_target, prop: string | symbol) {
      if (prop === '/') return Object.keys(persistedState)
      if (typeof prop === 'string') return persistedState[prop]
      return undefined
    },
    set(_target, prop: string | symbol, value: unknown) {
      if (typeof prop === 'string') {
        persistedState = { ...persistedState, [prop]: value }
        saveState()
      }
      return true
    },
    ownKeys() {
      return Reflect.ownKeys(persistedState)
    },
    getOwnPropertyDescriptor(_target, prop: string | symbol) {
      if (typeof prop === 'string' && prop in persistedState) {
        return {
          configurable: true,
          enumerable: true,
          writable: true,
          value: persistedState[prop],
        }
      }

      return undefined
    },
  })
}

export const store = createStore()

/** Return key-values as a `Record` object */
export function getAllKeyValues(): Record<string, unknown> {
  return { ...persistedState }
}

State.defaults = persistedState
State.subscribe(({ state }) => {
  if (state.flags.persist == true || state.flags.persist == 'api') {
    store(state.name, state.value)
  }
})
