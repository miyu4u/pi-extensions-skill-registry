import type { IndexedStats } from "../shared";

/** duplicate alias diagnostics를 deterministic하게 dedupe합니다. */
export const dedupeDuplicateAliasEntries = (
	entries: IndexedStats["duplicateAliasEntries"],
): IndexedStats["duplicateAliasEntries"] => {
	const deduped = new Map<string, IndexedStats["duplicateAliasEntries"][number]>();
	for (const entry of entries) {
		deduped.set(`${entry.alias}:${entry.canonicalName}:${entry.conflictingCanonicalName}`, entry);
	}
	return Array.from(deduped.values()).sort((left, right) => {
		if (left.alias !== right.alias) {
			return left.alias.localeCompare(right.alias);
		}
		if (left.canonicalName !== right.canonicalName) {
			return left.canonicalName.localeCompare(right.canonicalName);
		}
		return left.conflictingCanonicalName.localeCompare(right.conflictingCanonicalName);
	});
};
