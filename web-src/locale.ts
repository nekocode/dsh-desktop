/**
 * The languages the site speaks, and how each one is spelled to a machine.
 *
 * Its own module, below both `site.ts` and `strings.ts`, so that neither has to import the
 * other for it. That is what lets `site.ts` type a `labelKey` as an actual key of the string
 * table instead of as `string`: with the locale table living in `site.ts`, the two modules
 * formed a cycle and the type had to be widened and cast back at every use.
 */

export const LOCALES = ['en', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

/** English is the root: `/` serves it, every other locale lives under a prefix. */
export const ROOT_LOCALE: Locale = 'en';

/** BCP 47. `zh-Hans` rather than `zh`: the copy is Simplified, and hreflang should say so. */
export const LANG_TAG: Record<Locale, string> = { en: 'en', zh: 'zh-Hans' };

export const OG_LOCALE: Record<Locale, string> = { en: 'en_US', zh: 'zh_CN' };

/** How each language names itself, in itself — nobody looks for their language in a foreign word. */
export const LOCALE_NAME: Record<Locale, string> = { en: 'English', zh: '中文' };

/**
 * The one place a locale becomes a path segment.
 *
 * Page URLs, output filenames and the 404 lookup all used to spell the root-locale exception
 * themselves; four copies of one rule, and no compiler help when the scheme changes. A path
 * is a name under a locale's prefix, and the root locale's prefix is empty.
 */
export function localizedPath(locale: Locale, name: string): string {
  return locale === ROOT_LOCALE ? `/${name}` : `/${locale}/${name}`;
}
