/**
 * Parses the composed plugin tree emitted by `dsh --dump-config`.
 *
 * This is the single source of truth for the whole trim pipeline: which packages the backend needs
 * is decided entirely by this manifest rather than by a hand-maintained list on our side — a hand
 * list would inevitably drift as dsh is upgraded.
 */
import yaml from 'js-yaml';

/** One row of the composition tree. dsh's loader locates patches by `id` and packages by `name`. */
export type PluginRow = {
  readonly id: string;
  /** The full module specifier, possibly with a subpath (e.g. `@deepseek-ai/dsh-web-app/startup`). */
  readonly name: string;
  readonly disabled: boolean;
};

/**
 * `!!js <expr>` in dump-config is an expression for the loader to evaluate, not data.
 * Only id/name/disabled matter here, so it is captured verbatim as a string to keep js-yaml from
 * throwing on the unknown tag.
 */
const JS_EXPRESSION = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  construct: (data: unknown) => String(data ?? ''),
});

const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JS_EXPRESSION]);

/**
 * Colon-bearing specifiers such as `cordis:group` are the loader's built-in rows, not npm packages,
 * and must be excluded from tracing or resolution throws.
 */
function isPackageSpecifier(name: string): boolean {
  return !name.includes(':');
}

export function parseComposedConfig(text: string): PluginRow[] {
  const doc = yaml.load(text, { schema: SCHEMA });
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) {
    throw new Error('the composition manifest must be an array at top level, got: ' + typeof doc);
  }
  const out: PluginRow[] = [];
  collect(doc, false, out);
  return out;
}

/**
 * Recursively flattens the composition manifest. Agent presets hide plugin rows inside the `config`
 * array of `group: true` rows, so scanning only the top level misses half the packages (the
 * delegation / planning / compaction groups).
 *
 * When a group itself is disabled, its whole subtree never loads, so the disabled state is inherited.
 */
function collect(rows: readonly unknown[], inheritedDisabled: boolean, out: PluginRow[]): void {
  rows.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`composition manifest row ${index} is not an object`);
    }
    const row = raw as Record<string, unknown>;
    const id = typeof row['id'] === 'string' ? row['id'] : `#${index}`;
    const name = row['name'];
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error(`composition manifest row "${id}" has no name field`);
    }
    // `disabled: !!js <expr>` is a platform condition evaluated at runtime and undecidable at build
    // time. Always treated as not disabled: one package too many costs size, one too few crashes startup.
    const disabled = inheritedDisabled || row['disabled'] === true;

    if (row['group'] === true && Array.isArray(row['config'])) {
      collect(row['config'], disabled, out);
      return;
    }
    if (isPackageSpecifier(name)) out.push({ id, name, disabled });
  });
}
