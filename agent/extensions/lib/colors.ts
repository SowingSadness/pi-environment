/**
 * Theme color values.
 *
 * Agent configs normally reference a pi theme token (`accent`, `success`, `mdCode`, ...), but a literal
 * color is also accepted so one agent can use a color that no token provides. These helpers decide which
 * form a value is and convert a literal to the shape `Theme`/`parseColor` expect.
 */

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** True for `#rgb`/`#rrggbb`, `oklch(...)`, `okhsl(...)` and a bare ANSI index 0-255. */
export function isColorLiteral(value: string | undefined): boolean {
	if (!value) return false;
	const trimmed = value.trim();
	return HEX.test(trimmed) || /^oklch\(/i.test(trimmed) || /^okhsl\(/i.test(trimmed) || /^\d{1,3}$/.test(trimmed);
}

/** Converts a literal to the value accepted by theme JSON and `parseColor` (numbers for ANSI indexes). */
export function colorLiteralValue(value: string): string | number {
	const trimmed = value.trim();
	return /^\d{1,3}$/.test(trimmed) ? Number.parseInt(trimmed, 10) : trimmed;
}
