import type { IndexArtifacts } from "../shared";

/** 현재 process에서 활성화된 index identity와 snapshot token의 단일 mutable owner입니다. */
export class ActiveIndexStore {
	private cachedIndexValue: IndexArtifacts | null = null;
	private cachedDatabasePathValue = "";
	private activeSnapshotTokenValue = "";

	get cachedIndex(): IndexArtifacts | null {
		return this.cachedIndexValue;
	}

	get cachedDatabasePath(): string {
		return this.cachedDatabasePathValue;
	}

	get activeSnapshotToken(): string {
		return this.activeSnapshotTokenValue;
	}

	setDatabasePath(databasePath: string): void {
		this.cachedDatabasePathValue = databasePath;
	}

	activate(index: IndexArtifacts, snapshotToken: string): void {
		this.cachedIndexValue = index;
		this.activeSnapshotTokenValue = snapshotToken;
	}

	clear(): void {
		this.cachedIndexValue = null;
		this.activeSnapshotTokenValue = "";
	}

	assertActive(index: IndexArtifacts): string {
		if (index !== this.cachedIndexValue || !this.activeSnapshotTokenValue) {
			throw new Error("search index is not active; call loadIndex() before searching");
		}
		return this.activeSnapshotTokenValue;
	}
}
