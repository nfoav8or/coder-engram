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
