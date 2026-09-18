/**
 * dsh-context-handoff — browser half.
 *
 * Host plugins cannot move the browser's selected session: `uiWorkspace.openSession`
 * is client-only. This companion module watches the session list and, when a new
 * non-subagent session appears whose `parentId` is the currently selected
 * session, opens it automatically — so a context handoff is seamless instead of
 * asking the user to click the new session.
 *
 * Safety rails:
 *  - only sessions that arrive AFTER this module activates are candidates, so a
 *    page reload never yanks the user into an old continuation;
 *  - only `parentId === current` and `origin !== 'subagent'` rows qualify;
 *  - each child is opened at most once;
 *  - nothing happens until the first `ready` list snapshot is known.
 *
 * This file is hand-written in DSH's client bundle format (no `require` calls,
 * no third-party imports), so it can ship next to the host half and be served by
 * @deepseek-ai/dsh-client-modules from the plugin's own package directory.
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-handoff',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var LABEL = 'context-handoff(client)'

    function resolve(ctx, name) {
      if (ctx !== undefined && ctx !== null && typeof ctx.get === 'function') {
        try {
          var service = ctx.get(name)
          if (service !== undefined) return service
        } catch {
          /* fall through to the property form */
        }
      }
      try {
        return ctx !== undefined && ctx !== null ? ctx[name] : undefined
      } catch {
        return undefined
      }
    }

    function snapshotOf(sessions) {
      try {
        return sessions?.list?.getSnapshot?.()
      } catch {
        return undefined
      }
    }

    /** Small, read-only debug surface: proves the browser half applied and records opens. */
    function debugState() {
      if (typeof window === 'undefined') return undefined
      if (window.__dshContextHandoff === undefined) {
        window.__dshContextHandoff = { applied: false, opened: [], lastError: undefined }
      }
      return window.__dshContextHandoff
    }

    function apply(ctx) {
      var debug = debugState()
      if (debug !== undefined) debug.applied = true
      var sessions = resolve(ctx, 'sessions')
      var uiWorkspace = resolve(ctx, 'uiWorkspace')
      if (sessions === undefined || sessions === null || sessions.list === undefined) {
        if (debug !== undefined) debug.lastError = 'sessions service unavailable'
        return
      }
      if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.openSession !== 'function') {
        if (debug !== undefined) debug.lastError = 'uiWorkspace service unavailable'
        return
      }

      /** Session ids known before activation (never auto-opened) plus arrivals already judged. */
      var known = new Set()
      /** Child ids this module already opened. */
      var opened = new Set()
      var initialized = false
      var timer

      function consider() {
        var snap = snapshotOf(sessions)
        if (snap === undefined || snap === null || !Array.isArray(snap.ids)) return
        if (snap.phase !== undefined && snap.phase !== 'ready') return

        if (!initialized) {
          initialized = true
          for (var index = 0; index < snap.ids.length; index += 1) known.add(snap.ids[index])
          return
        }

        var current = snap.current
        for (var cursor = 0; cursor < snap.ids.length; cursor += 1) {
          var id = snap.ids[cursor]
          if (known.has(id)) continue
          known.add(id)
          if (current === undefined || current === null) continue
          var summary = snap.byId !== undefined && snap.byId !== null ? snap.byId[id] : undefined
          if (summary === undefined || summary === null) continue
          if (summary.origin === 'subagent') continue
          if (summary.blank === true) continue
          if (summary.parentId !== current) continue
          if (opened.has(id)) continue
          opened.add(id)
          if (debug !== undefined) debug.opened.push(id)
          try {
            uiWorkspace.openSession(id)
          } catch (error) {
            // A failed open must never break the client; the new session is
            // still visible in the sidebar.
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
              console.warn(`${LABEL}: could not open continuation session ${id}: ${String(error)}`)
            }
          }
          return
        }
      }

      function schedule() {
        if (timer !== undefined) return
        timer = setTimeout(() => {
          timer = undefined
          consider()
        }, 0)
      }

      var unsubscribe
      if (typeof sessions.list.subscribe === 'function') {
        unsubscribe = sessions.list.subscribe(schedule)
      }
      ctx.effect(() => () => {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        if (typeof unsubscribe === 'function') {
          try {
            unsubscribe()
          } catch {
            /* ignore */
          }
        }
      }, `${LABEL}: auto-open continuation`)

      // Cover the case where the list became ready before this module activated.
      consider()
    }

    exports.apply = apply
    exports.inject = ['sessions', 'uiWorkspace']
    return module.exports
  },
})
