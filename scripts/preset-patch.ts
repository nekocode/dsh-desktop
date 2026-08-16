/**
 * Disables rows in an agent preset composition.
 *
 * Why not the profile patch mechanism: `profile-boot` hard-codes the preset root as a
 * "shipped root wins" overlay, which the user layer cannot override at all. Cutting on the preset
 * plane can only be done by editing our own copy of the preset file.
 *
 * Why text insertion rather than a YAML round-trip: the comments in upstream's preset files *are*
 * the design documentation (why a row belongs to the host plane, why it must not enter a realm),
 * and one round-trip erases all of them.
 */

/** Matches a `- id: <name>` line, capturing its indentation. */
function rowHeadPattern(id: string): RegExp {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^(\\s*)- id: ${escaped}\\s*$`);
}

/**
 * Inserts `disabled: true` after the `name:` of every target row.
 *
 * After name rather than after id: the loader resolves packages by name, so keeping the switch next
 * to it makes "this package is disabled" obvious at a glance.
 */
export type PresetPatchResult = {
  readonly text: string;
  /** The row ids actually matched. The caller uses this to tell whether "nothing changed" means upstream changed. */
  readonly disabled: readonly string[];
};

export function disablePresetRows(text: string, rowIds: readonly string[]): PresetPatchResult {
  let out = text;
  const disabled: string[] = [];
  for (const id of rowIds) {
    const next = disableOne(out, id);
    // A row already disabled counts as neither a hit nor a miss — only "the row is not in the file
    // at all" is a problem, and disableOne returns the original text in that case too. The caller
    // aggregates across every preset file before deciding.
    if (next !== out) disabled.push(id);
    out = next;
  }
  return { text: out, disabled };
}

function disableOne(text: string, id: string): string {
  const lines = text.split('\n');
  const head = rowHeadPattern(id);
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    out.push(line);

    const match = head.exec(line);
    if (match === null) continue;

    // A row's properties are indented two spaces past the `- `: for `  - id: x` they read `    name: ...`.
    const propIndent = `${match[1] ?? ''}  `;
    const nameIndex = findNameLine(lines, i + 1, propIndent);
    if (nameIndex === -1) continue;

    for (let j = i + 1; j <= nameIndex; j++) out.push(lines[j] ?? '');
    i = nameIndex;

    const next = lines[nameIndex + 1] ?? '';
    if (next.trim() !== 'disabled: true') out.push(`${propIndent}disabled: true`);
  }

  return out.join('\n');
}

/** Finds this row's own `name:` at the same indentation level, without crossing into the next entry. */
function findNameLine(lines: readonly string[], from: number, propIndent: string): number {
  for (let i = from; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (!line.startsWith(propIndent)) return -1;
    if (line.startsWith(`${propIndent}name:`)) return i;
  }
  return -1;
}
