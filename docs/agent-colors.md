# Per-agent colors: input border + agent badge

Requirement: per agent, set exactly two colors, and reference **pi theme token names** instead of
literal color values.

| Config field | Effect |
|---|---|
| `inputColor` | color of the editor input border (the "field") |
| `statusColor` | color of the `agent:<name>` badge in the status/footer line |

Values are token names from `Theme.colors` (`accent`, `success`, `warning`, `error`, `border`,
`borderAccent`, `borderMuted`, `muted`, `dim`, `text`, `syntax*`, `md*`, `thinking*`, …).
No `#hex` / `okhsl()` in the agents config.

## Findings in pi 1.4.0 (why it works this way)

- The input border is **not** `border`/`borderMuted`. On every thinking-level or bash-mode change
  `interactive-mode.js:3656-3660` does:
  ```js
  this.editor.borderColor = this.isBashMode
    ? theme.getBashModeBorderColor()
    : theme.getThinkingBorderColor(this.session.thinkingLevel || "off");
  ```
  and `theme.js:244-263` implements that as `fg("thinkingOff" | "thinkingMinimal" | … | "thinkingMax")`.
- Therefore overriding **all seven `thinking*` tokens** in a derived theme colors the input border and
  keeps it stable when the user cycles thinking levels — no editor component replacement needed.
- The working / compaction status text embedded into the editor's top border reuses `editor.borderColor`
  (`interactive-mode.js:1813-1816`), so it inherits the same agent color for free.
- Bash mode (`!`) keeps its own `bashMode` token, so shell input stays visually distinct.
- The agent badge is our own `ctx.ui.setStatus("agent", …)` string rendered with
  `ctx.ui.theme.fg(token, text)`, so its color needs no theme mutation at all.

## 1. `~/.pi/agent/agents.json`

```json
"architect": { "inputColor": "accent",  "statusColor": "accent" },
"coder":     { "inputColor": "success", "statusColor": "success" },
"reviewer":  { "inputColor": "warning", "statusColor": "warning" }
```

`accent` = violet, `success` = green, `warning` = yellow/orange in the built-in palettes; with the
`system` theme they follow the terminal palette. Both fields are independent: e.g.
`"inputColor": "accent", "statusColor": "muted"` is valid.

## 2. `~/.pi/agent/extensions/agents.ts`

### Imports

```ts
import { CONFIG_DIR_NAME, getAgentDir, Theme } from "@earendil-works/pi-coding-agent";
import { Key, colorToHex, type Color, type ThemeColor } from "@earendil-works/pi-tui";
```

### Config fields (replace the earlier `theme?: Record<string, …>` idea)

```ts
	/** Theme token name for the editor input border color. */
	inputColor?: string;
	/** Theme token name for the `agent:<name>` badge in the status line. */
	statusColor?: string;
```

### Token constant + helpers (next to `buildGuard`)

```ts
/** The editor border uses these tokens, one per thinking level. */
const THINKING_TOKENS = [
	"thinkingOff",
	"thinkingMinimal",
	"thinkingLow",
	"thinkingMedium",
	"thinkingHigh",
	"thinkingXhigh",
	"thinkingMax",
] as const;

function readThemeSetting(cwd: string): string | undefined {
	for (const path of [join(cwd, CONFIG_DIR_NAME, "settings.json"), join(getAgentDir(), "settings.json")]) {
		if (!existsSync(path)) continue;
		try {
			const value = (JSON.parse(readFileSync(path, "utf-8")) as { theme?: unknown }).theme;
			if (typeof value === "string" && value) return value;
		} catch {
			// malformed settings: fall back to the captured theme instance
		}
	}
	return undefined;
}

function themeColorValue(color: Color): string | number {
	return color.kind === "indexed" ? color.index : colorToHex(color);
}

/** Copy of `base` where every `target` token takes the color of `tokenMap[target]`. */
function deriveTheme(base: Theme, tokenMap: Record<string, string>, onUnknown: (name: string) => void): Theme {
	const baseColors = base.colors as Record<string, Color>;
	const values: Record<string, string | number> = {};
	for (const [token, color] of Object.entries(baseColors)) values[token] = themeColorValue(color);

	const colors = { ...values };
	for (const [target, source] of Object.entries(tokenMap)) {
		if (!(target in values) || !(source in values)) {
			onUnknown(target in values ? source : target);
			continue;
		}
		colors[target] = values[source];
	}

	// `dimTokens` is internal state of the running theme; keep it so faint tokens stay faint.
	const dim = (base as unknown as { dimTokens?: Set<string> }).dimTokens;
	return new Theme(colors, {}, base.getColorMode(), {
		name: base.name,
		appearance: base.appearance,
		dim: dim ? ([...dim] as ThemeColor[]) : undefined,
	});
}
```

### Factory state

```ts
	let originalTheme: Theme | undefined;
	let inputColorToken: string | undefined;
	let statusColorToken = "accent";
```

### Token resolution + apply/restore

```ts
	function resolveColorToken(ctx: ExtensionContext, value: string | undefined, fallback: string, field: string): string {
		const name = value?.trim();
		if (!name) return fallback;
		if (name in (ctx.ui.theme.colors as Record<string, unknown>)) return name;
		ctx.ui.notify(`agents: unknown theme color "${name}" in ${field}; using ${fallback}`, "warning");
		return fallback;
	}

	function restoreBaseTheme(ctx: ExtensionContext) {
		if (ctx.mode !== "tui" || !originalTheme) return;
		const setting = readThemeSetting(ctx.cwd);
		// A plain theme name restores the controller's auto-sync (system theme / light-dark pairs)
		// without writing settings: pi only persists when the stored setting differs.
		if (setting && !setting.includes("/")) ctx.ui.setTheme(setting);
		else ctx.ui.setTheme(originalTheme);
	}

	function applyInputColor(ctx: ExtensionContext, token: string | undefined) {
		if (ctx.mode !== "tui") return;
		if (!originalTheme) originalTheme = ctx.ui.theme;
		if (!token) {
			restoreBaseTheme(ctx);
			return;
		}

		const tokenMap = Object.fromEntries(THINKING_TOKENS.map((thinkingToken) => [thinkingToken, token]));
		const derived = deriveTheme(originalTheme, tokenMap, (name) =>
			ctx.ui.notify(`agents: unknown theme color "${name}"`, "warning"),
		);
		const result = ctx.ui.setTheme(derived);
		if (!result.success) ctx.ui.notify(`agents: cannot apply theme: ${result.error ?? "unknown error"}`, "warning");
	}
```

### Status badge uses the token directly

```ts
	function updateStatus(ctx: ExtensionContext) {
		if (!activeName) {
			ctx.ui.setStatus("agent", undefined);
			return;
		}
		const suffix = activeGuard ? " (ro)" : "";
		ctx.ui.setStatus("agent", ctx.ui.theme.fg(statusColorToken, `agent:${activeName}${suffix}`));
	}
```

### Call sites

- `activate()` after the tools block:
  ```ts
  		inputColorToken = agent.inputColor ? resolveColorToken(ctx, agent.inputColor, "borderMuted", "inputColor") : undefined;
  		statusColorToken = resolveColorToken(ctx, agent.statusColor, "accent", "statusColor");
  		applyInputColor(ctx, inputColorToken);
  ```
  (keep the existing `updateStatus(ctx)` call after that — it now renders with the new token.)
- `deactivate()`:
  ```ts
  		inputColorToken = undefined;
  		statusColorToken = "accent";
  		restoreBaseTheme(ctx);
  ```
  before `updateStatus(ctx)`.
- `session_start`, right after `clearActive(); originalState = undefined;`:
  ```ts
  		restoreBaseTheme(ctx);
  ```
  and in the `saved && agents[saved]` restore branch:
  ```ts
  		inputColorToken = agents[saved].inputColor
  			? resolveColorToken(ctx, agents[saved].inputColor, "borderMuted", "inputColor")
  			: undefined;
  		statusColorToken = resolveColorToken(ctx, agents[saved].statusColor, "accent", "statusColor");
  		applyInputColor(ctx, inputColorToken);
  ```

## 3. Tests

1. `pi --help` in a scratch cwd: extension loads, no errors, `--agent` listed.
2. TUI, `pi --agent architect`: input border violet, badge `agent:architect` violet.
3. `shift+tab` (thinking level cycle): border color stays violet — proves all `thinking*` tokens were
   overridden, not just the level the agent set.
4. `!ls` (bash mode): border switches to the `bashMode` color; leaving bash mode returns to violet.
5. `ctrl+alt+2` (`/agent coder`): border and badge become green; `ctrl+alt+3` — yellow/orange.
6. `/agent none`: original theme returns, badge disappears, `system` theme follows terminal light/dark again.
7. Restart with `--agent coder`, then `/agent reviewer`: no accumulation (each derive starts from the
   captured `originalTheme`).
8. Invalid names (`"inputColor": "nope"`, `"statusColor": "#ff0000"`): one warning each, fallbacks applied
   (`borderMuted` / `accent`), no crash.

## Caveats

- Overriding `thinking*` deliberately removes the per-level border gradient while an agent with
  `inputColor` is active; the level still exists, it just renders in the agent color.
- The embedded working/compaction text in the editor's top border inherits the agent color (intended).
- Bash-mode input keeps `bashMode`; not overridden by `inputColor`.
- TUI only (`ctx.mode === "tui"`); JSON/print/RPC sessions are untouched.
- While the derived theme is active, the `system` theme stops live-following terminal appearance changes;
  `/agent none` restores it by name when the settings theme is a plain name (not a `light/dark` pair).
- Terminal-default (`""`) tokens are converted to concrete colors in the derived theme, so a cloned theme
  no longer inherits the terminal's own palette for those tokens.
- `dimTokens` is internal `Theme` state; if a future pi release renames it, only faint rendering changes.
