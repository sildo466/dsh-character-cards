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

    // A package whose client half cannot be required takes the whole module
    // down, and an unregistered specifier throws on the spot rather than
    // returning undefined. So the lookup is guarded, and the switcher falls
    // back to a plain select when the primitives are not where this build
    // expects them - a plain control beats a broken client.
    let primitives
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch {
      primitives = undefined
    }
    const Menu = primitives?.Menu
    const Pill = primitives?.Pill
    const Chevron = primitives?.IconChevronDownOutline14
    const canUseMenu = typeof Menu === 'function' && typeof Pill === 'function'

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
     * Option values are namespaced - `card:<id>`, `none`, `default` - so a card
     * whose id happens to read "none" still gets its own option.
     *
     * The two modes answer different questions. Global mode only ever picks a
     * card, so it shows the current default. Session mode has three answers:
     * a pinned card, no card at all, or follow the default - and the last two
     * are distinct even though both leave `cardId` reporting the default.
     * @param mode - `'session'` or `'global'`.
     * @param cards - the `/cards` payload.
     * @param session - the `/session/<id>` payload, or undefined in global mode.
     * @returns the value to select.
     */
    function initialSelection(mode, cards, session) {
      if (mode === 'global') return cards?.defaultCard ? `card:${cards.defaultCard}` : ''
      if (session === undefined || !Object.hasOwn(session, 'override')) return 'default'
      return session.override === null ? 'none' : `card:${session.override}`
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
     * The options a switcher offers, in menu order.
     *
     * One source, two presentations: the popover menu and the fallback select
     * both render this list, so they cannot disagree about what is on offer.
     * `id` is the option value, namespaced as `card:<id>` / `none` / `default`
     * so a card whose id literally reads "none" keeps its own row.
     * @param mode - `'session'` or `'global'`.
     * @param cards - the `/cards` payload.
     * @returns the entries, in the order a menu should show them.
     */
    function switcherEntries(mode, cards) {
      const entries = []
      if (mode === 'session') {
        entries.push({ id: 'none', label: '不使用角色卡' })
        entries.push({ id: 'default', label: '跟随默认' })
      }
      for (const card of cards?.cards ?? []) {
        entries.push({ id: `card:${card.id}`, label: card.name ?? card.id })
      }
      return entries
    }

    /**
     * Styling for the fallback select only; the primary control is a Pill.
     *
     * A native select is chunky by default, which reads as a form control
     * dropped into a row of small icon buttons. Stripping its chrome at least
     * lets it blend instead of announcing itself.
     */
    const CHIP_STYLE = {
      appearance: 'none',
      border: 0,
      borderRadius: '6px',
      background: 'transparent',
      color: 'inherit',
      font: 'inherit',
      padding: '2px 0',
      cursor: 'pointer',
      maxWidth: '150px',
    }

    /**
     * Card picker for a cell beside the composer.
     *
     * The trigger is a Pill and the popup is the shipped Menu, so the control
     * wears the same clothes as the ones beside it and dsh keeps ownership of
     * anchoring and outside-click dismissal. When those primitives are missing,
     * the same entries render as a plain select - plainer, but still working.
     * @param props - slot props; `sessionId` selects the mode.
     */
    function CardSwitcher(props) {
      const mode = switcherMode(props)
      const sessionId = mode === 'session' ? props.sessionId : undefined
      const [state, setState] = react.useState({ status: 'loading', entries: [], value: '' })
      const [open, setOpen] = react.useState(false)

      react.useEffect(() => {
        let cancelled = false
        const load = async () => {
          const cards = await getJson('/cards')
          if (cancelled) return
          if (cards === undefined) {
            setState({ status: 'error', entries: [], value: '' })
            return
          }
          const session = sessionId === undefined
            ? undefined
            : await getJson(`/session/${encodeURIComponent(sessionId)}`)
          if (cancelled) return
          setState({
            status: 'ready',
            entries: switcherEntries(mode, cards),
            value: initialSelection(mode, cards, session),
          })
        }
        void load()
        return () => { cancelled = true }
      }, [mode, sessionId])

      // Nothing at all until the host answers: a control that appears and then
      // changes its mind is worse than one that appears settled.
      if (state.status === 'loading') return null
      if (state.status === 'error') {
        return react.createElement('span', { style: { opacity: 0.5, fontSize: '12px' } }, '角色卡')
      }

      const choose = (option) => {
        setOpen(false)
        setState(previous => ({ ...previous, value: option }))
        if (sessionId === undefined) {
          if (option.startsWith('card:')) {
            void postJson('/default', { cardId: option.slice('card:'.length) })
          }
          return
        }
        const sessionPath = `/session/${encodeURIComponent(sessionId)}/card`
        // The body's shape carries the answer: a card id pins, null takes no
        // card at all, and an empty body drops the entry.
        if (option === 'none') void postJson(sessionPath, { cardId: null })
        else if (option === 'default') void postJson(sessionPath, {})
        else void postJson(sessionPath, { cardId: option.slice('card:'.length) })
      }

      if (canUseMenu) {
        const current = state.entries.find(entry => entry.id === state.value)
        return react.createElement(Menu, {
          open,
          items: state.entries,
          selectedId: state.value,
          onSelect: choose,
          onClose: () => setOpen(false),
          // Opening upward is what a control at the bottom of the composer
          // needs, and it is what the shipped permission selector does.
          side: 'top',
          anchor: react.createElement(
            Pill,
            { onClick: () => setOpen(!open), active: open, title: '角色卡' },
            react.createElement('span', null, current?.label ?? '角色卡'),
            Chevron === undefined ? null : react.createElement(
              'span',
              { style: { marginLeft: '4px', display: 'inline-flex', verticalAlign: 'middle' }, 'aria-hidden': true },
              react.createElement(Chevron),
            ),
          ),
        })
      }

      return react.createElement(
        'select',
        {
          style: CHIP_STYLE,
          value: state.value,
          title: '角色卡',
          onChange: (event) => choose(event.target.value),
        },
        state.entries.map(entry =>
          react.createElement('option', { key: entry.id, value: entry.id }, entry.label)),
      )
    }

    /**
     * Activate the browser half.
     * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
     */
    function apply(ctx) {
      /**
       * Contribute one cell to a slot, tolerating its absence.
       *
       * `slots.inject` fires only once something declares the key, so a key the
       * running build does not have is silent rather than fatal - a direct
       * `slots.register` against an undeclared slot fails plugin activation
       * instead. Each mount is isolated because a client plugin that throws out
       * of apply() can take the whole client composition with it, which is how
       * plugin entries disappear from the UI entirely.
       * @param key - the slot to contribute to.
       * @param options - registration options; the protocol is id / order / label.
       * @param component - the component to render in that cell.
       */
      const mount = (key, options, component) => {
        try {
          const slots = ctx.get('slots')
          if (slots === undefined || typeof slots.inject !== 'function') return
          slots.inject(key, () => slots.register(options, component))
        } catch {
          // An absent or reshaped slot must degrade to "this surface is
          // missing", never to a broken client.
        }
      }

      // A settings page is the documented way to obtain a whole content area.
      // `id` has to be unique among sections - 'plugins' and 'agent-presets'
      // are shipped ones - and `order` places this entry in the navigation.
      mount('settings.section', {
        name: 'settings.section',
        id: 'character-cards',
        order: 20,
        label: () => '角色卡',
      }, CardSettingsSection)

      // The composer tool row. Confirmed against the live client tree rather
      // than guessed: list cardinality, session scope, replaceRisk none, and an
      // empty occupant list. A list slot under a fresh id is purely additive,
      // so this cannot displace the tools already sitting in that row.
      //
      // Not conversation.input.dock, where the git-graph branch chip lives: that
      // chip renders only for a blank session, and a card switcher that appears
      // only before a session starts cannot do the one thing it is for.
      mount('conversation.input.left', {
        name: 'conversation.input.left',
        id: 'character-cards',
        order: 0,
      }, CardSwitcher)
    }

    return { apply, initialSelection, switcherEntries, switcherMode }
  },
})
