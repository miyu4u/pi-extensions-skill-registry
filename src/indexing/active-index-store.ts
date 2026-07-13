import type { IndexArtifacts } from "../shared";

/** 현재 process에서 활성화된 index identity와 snapshot token의 단일 mutable owner입니다. */
export class ActiveIndexStore {
	cachedIndex: IndexArtifacts | null = null;
	cachedDatabasePath = "";
	activeSnapshotToken = "";

	activate(index: IndexArtifacts, snapshotToken: string): void {
		this.cachedIndex = index;
		this.activeSnapshotToken = snapshotToken;
	}

	clear(): void {
		this.cachedIndex = null;
		this.activeSnapshotToken = "";
	}

	assertActive(index: IndexArtifacts): string {
		if (index !== this.cachedIndex || !this.activeSnapshotToken) {
			throw new Error("search index is not active; call loadIndex() before searching");
		}
		return this.activeSnapshotToken;
	}
}
