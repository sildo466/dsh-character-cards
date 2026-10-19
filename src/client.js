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
     * The settings page: every card, what each one costs, and which one new
     * sessions default to.
     *
     * Root-scoped, so it has no session to switch and offers no "follow the
     * default" entry - that only means something where a session is in hand.
     * @returns {unknown} the section element.
     */
    function CardSettingsSection() {
      const [state, setState] = react.useState({ status: 'loading', cards: [], defaultCard: null })

      react.useEffect(() => {
        let cancelled = false
        void (async () => {
          const payload = await getJson('/cards')
          if (cancelled) return
          setState(payload === undefined
            ? { status: 'error', cards: [], defaultCard: null }
            : { status: 'ready', cards: payload.cards ?? [], defaultCard: payload.defaultCard ?? null })
        })()
        return () => { cancelled = true }
      }, [])

      if (state.status === 'loading') return react.createElement('p', null, '读取卡片库…')
      if (state.status === 'error') return react.createElement('p', null, '无法读取卡片库。')

      const chooseDefault = (next) => {
        setState(previous => ({ ...previous, defaultCard: next }))
        void postJson('/default', { cardId: next })
      }

      const rows = state.cards.map(entry => react.createElement(
        'li',
        { key: entry.id, style: { display: 'flex', gap: '12px', padding: '4px 0' } },
        react.createElement('span', { style: { flex: 1, minWidth: 0 } }, entry.name ?? entry.id),
        react.createElement('span', { style: { opacity: 0.7, whiteSpace: 'nowrap' } },
          `${entry.tokens} / ${entry.maxTokens} token`),
        entry.truncated ? react.createElement('span', { style: { opacity: 0.7 } }, '已截断') : null,
      ))

      return react.createElement(
        'div',
        { style: { lineHeight: 1.7 } },
        react.createElement('p', { style: { margin: '0 0 8px' } },
          react.createElement('span', null, '默认卡 '),
          react.createElement(
            'select',
            { value: state.defaultCard ?? '', onChange: (event) => chooseDefault(event.target.value) },
            state.cards.map(entry =>
              react.createElement('option', { key: entry.id, value: entry.id }, entry.name ?? entry.id)),
          ),
        ),
        state.cards.length === 0
          ? react.createElement('p', null, '卡片库为空。把 .dshcd 文件放进 ~/.dsh/character-cards/ 即可。')
          : react.createElement('ul', { style: { margin: 0, padding: 0, listStyle: 'none' } }, rows),
      )
    }

    /**
     * Card picker for a slot beside the composer. Degrades to a plain static
     * label whenever the host is unreachable, so a broken fetch can never take
     * the composer down.
     *
     * Not mounted yet: it belongs on a session-scoped slot, and the live client
     * tree has to be queried before registering into one - an undeclared key
     * fails during plugin activation. Its two pure helpers are exported and
     * covered so the mount is the only thing left when that key is known.
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
        // A settings page is the documented way to obtain a whole content area,
        // and `id` has to be unique among existing sections - 'plugins' is the
        // shipped one. `order` places this entry after it in the navigation.
        slots.inject('settings.section', () => slots.register({
          name: 'settings.section',
          id: 'character-cards',
          order: 20,
          label: () => '角色卡',
        }, CardSettingsSection))
      } catch {
        // A missing or reshaped slot must degrade to "no settings page", never
        // to a broken client.
      }
    }

    return { apply, initialSelection, switcherMode }
  },
})
