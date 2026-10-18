// dsh-character-cards - client half.
//
// A self-adaptive card switcher: a slot that hands over a `sessionId` switches
// that session's card, a slot that does not switches the global default. The
// same component serves both surfaces; `switcherMode` makes the choice explicit
// and testable.
//
// The module is a classic client bundle (client-modules protocol): it registers
// a factory with window.__ModuleLoader__ and returns apply(). `react` is a
// platform module (packages/client/web/src/platform.ts), seeded into the frozen
// module table before any bundle materializes, so it needs no `dsh.client.inject`
// edge. Everything else is read through ctx.get() with an absence check.
window.__ModuleLoader__.load({
  id: 'dsh-character-cards',
  factory: (require) => {
    const react = require('react')

    const ROUTE = '/dsh-character-cards'

    /**
     * Which surface a switcher instance is: a slot that hands over a sessionId
     * switches that session, a slot that does not switches the global default.
     * @param props - the slot's props.
     * @returns the mode.
     */
    function switcherMode(props) {
      return typeof props?.sessionId === 'string' && props.sessionId.length > 0 ? 'session' : 'global'
    }

    /** GET JSON, returning undefined instead of throwing. */
    async function getJson(path) {
      try {
        const res = await fetch(`${ROUTE}${path}`)
        if (!res.ok) return undefined
        return await res.json()
      } catch {
        return undefined
      }
    }

    /** POST JSON, returning undefined instead of throwing. */
    async function postJson(path, body) {
      try {
        const res = await fetch(`${ROUTE}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!res.ok) return undefined
        return await res.json()
      } catch {
        return undefined
      }
    }

    /**
     * Which option a switcher shows before the user touches it.
     *
     * The two modes answer different questions. Global mode has no "follow the
     * default" entry, so it must show the current default itself. Session mode
     * shows the session's own override, or the empty value that means "follow
     * the default".
     * @param mode - `'session'` or `'global'`.
     * @param cards - the `/cards` payload.
     * @param session - the `/session/<id>` payload, or undefined in global mode.
     * @returns the value to select.
     */
    function initialSelection(mode, cards, session) {
      if (mode === 'global') return cards?.defaultCard ?? ''
      return session?.override ?? ''
    }

    /**
     * Card picker. Degrades to a plain static label whenever the host is
     * unreachable, so a broken fetch can never take the composer down.
     * @param props - slot props; `sessionId` selects the mode.
     */
    function CardSwitcher(props) {
      const mode = switcherMode(props)
      const sessionId = mode === 'session' ? props.sessionId : undefined
      const [state, setState] = react.useState({ ready: false, cards: [], value: '' })

      react.useEffect(() => {
        let cancelled = false
        const load = async () => {
          const cards = await getJson('/cards')
          if (cancelled || cards === undefined) return
          const session = sessionId === undefined
            ? undefined
            : await getJson(`/session/${encodeURIComponent(sessionId)}`)
          if (cancelled) return
          setState({
            ready: true,
            cards: cards.cards ?? [],
            value: initialSelection(mode, cards, session),
          })
        }
        void load()
        return () => { cancelled = true }
      }, [mode, sessionId])

      if (!state.ready) return react.createElement('span', null, '角色卡')

      const choose = (next) => {
        setState(previous => ({ ...previous, value: next }))
        void postJson(
          sessionId === undefined ? '/default' : `/session/${encodeURIComponent(sessionId)}/card`,
          sessionId === undefined ? { cardId: next } : { cardId: next === '' ? null : next },
        )
      }

      const options = state.cards.map(card =>
        react.createElement('option', { key: card.id, value: card.id }, card.name ?? card.id))
      if (sessionId !== undefined) {
        options.unshift(react.createElement('option', { key: '__default', value: '' }, '跟随默认'))
      }

      return react.createElement(
        'select',
        { value: state.value, onChange: (event) => choose(event.target.value), title: '角色卡' },
        options,
      )
    }

    /**
     * Activate the browser half.
     * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
     */
    function apply(ctx) {
      // Every step is optional and silent on failure: a client plugin that
      // throws out of apply() can take the whole client composition down with
      // it, which is how plugin entries disappear from the UI entirely.
      try {
        const slots = ctx.get('slots')
        if (slots === undefined || typeof slots.inject !== 'function') return
        slots.inject('plugins.row.config', () => slots.register(
          { name: 'plugins.row.config', key: 'dsh-character-cards#dsh-character-cards' },
          CardSwitcher,
        ))
      } catch {
        // A missing or reshaped slot must degrade to "no card pane", never to
        // a broken client.
      }
    }

    return { apply, initialSelection, switcherMode }
  },
})
