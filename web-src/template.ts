/**
 * The `{{key}}` placeholder engine — the bottom layer of the site build.
 *
 * Plain string replacement, no HTML parser. The templates are ours; a parser would buy
 * nothing and cost a dependency, and a regex over `{{...}}` is not confused by a tag that
 * was reflowed across lines.
 */

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** What is still unresolved. The build uses it to refuse to ship a literal `{{heroTitle}}`. */
export function placeholdersIn(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map(([, name]) => name as string);
}

/** `fill` policy: leave an unknown placeholder for a later pass. */
export function keep(name: string): string {
  return `{{${name}}}`;
}

/** `fill` policy: an unknown placeholder is a build failure. Far better than shipping one. */
export function throwOnMissing(name: string): never {
  throw new Error(`web template: unknown placeholder {{${name}}}`);
}

/**
 * Give every continuation line the indentation the placeholder itself sat at. The template
 * owns the layout and the generator emits flat lines; baking the indent into the generator
 * means the template's next reflow silently misaligns its own output.
 *
 * Blank lines stay bare — padding them plants trailing whitespace on every one of them.
 */
function reindent(value: string, pad: string): string {
  return value
    .split('\n')
    .map((line, index) => (index === 0 || line === '' ? line : pad + line))
    .join('\n');
}

function leadingPad(template: string, offset: number): string {
  const prefix = template.slice(template.lastIndexOf('\n', offset - 1) + 1, offset);
  return /^[ \t]*$/.test(prefix) ? prefix : '';
}

export function fill(
  template: string,
  values: Readonly<Record<string, string>>,
  onMissing: (name: string) => string,
): string {
  // Replacement via the function form: a `$&` inside a value (CSS selectors, code samples)
  // would otherwise be eaten as a back-reference.
  return template.replace(PLACEHOLDER, (_match, name: string, offset: number) => {
    const value = Object.hasOwn(values, name) ? (values[name] as string) : onMissing(name);
    return reindent(value, leadingPad(template, offset));
  });
}

/**
 * Strip the comments written for whoever edits the template — build warnings, section
 * markers, why-this-looks-like-this. None of it is content, and all of it would otherwise
 * be served to every visitor. Only own-line comments go; inline ones are deliberate.
 */
export function stripComments(html: string): string {
  return html.replace(/^[ \t]*<!--[\s\S]*?-->\n?/gm, '');
}
