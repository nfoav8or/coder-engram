/**
 * Fold a value for FILTER COMPARISON — never for storing a path or reading a
 * file, where the exact bytes on disk are what the adapter needs.
 *
 * Case folds because a user who types "private" for a folder named "Private"
 * means that folder, and on macOS and Windows the filesystem folds case anyway.
 *
 * Unicode normalization folds for the same reason one step further out: macOS
 * stores an accented filename DECOMPOSED (NFD — "e" plus a combining accent)
 * while the same name typed into the settings box arrives COMPOSED (NFC, one
 * codepoint). They are one name to a person and to the filesystem, but two
 * different strings, so an exclusion or a search filter naming an accented
 * folder/tag silently matched nothing — for an exclusion, that left those
 * notes indexed and readable over the server; for a search filter, it made a
 * legitimately-scoped search return nothing.
 */
export function foldForCompare(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

/**
 * Fold a folder setting to the form the path comparisons use. Drops the empty
 * and `.` segments that `normalizeVaultRelativePath` drops everywhere else, so
 * "./Private", "/Private/" and "Private" all name the same folder here as they
 * do in the rest of the codebase.
 *
 * Shared, because it existed twice with DIFFERENT rules: the vault scanner
 * split on `/` and dropped empty/`.` segments, while the search-filter path
 * only stripped leading and trailing slashes. The same string therefore
 * excluded a folder correctly but matched nothing as a `folder` search filter
 * — zero results, indistinguishable from "nothing matched", which is the same
 * silent-failure shape as comparing without folding case.
 */
export function normalizeFolder(folder: string): string {
  return folder
    .trim()
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/");
}

/**
 * Strip a leading UTF-8 byte-order mark.
 *
 * A BOM is invisible but it is a real character at offset 0, so every
 * start-anchored pattern misses on the first line: `^---` did not match, and
 * the whole frontmatter block — including a `tags:` entry — was skipped, which
 * makes it a privacy fail-open (an excluded note gets indexed and served). It
 * cost the first heading too, since `^#` missed the same way. Windows editors,
 * PowerShell redirection and some export tools all emit one.
 *
 * Removing it shifts no LINE index: the BOM lives inside line 0, so chunk line
 * spans are unaffected.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
