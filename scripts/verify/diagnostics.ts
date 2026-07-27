/**
 * stale source/dist, lock drift, wrong install, root loss, normalization failure를
 * 한 화면에서 구분하기 위한 verification diagnostic payload입니다.
 */
export type VerificationDiagnostics = {
	repositoryVersion: string | null;
	lockVersion: string | null;
	installedVersion: string | null;
	repositoryBundle: string | null;
	installedBundle: string | null;
	installedRealpath: string | null;
	bundleChecksumMatch: boolean | null;
	requestedRoots: string[];
	queriedRoots: string[];
	indexed: number | null;
	parsed: number | null;
	discoveredNames: string[];
	resolvedNames: string[];
	missingNames: string[];
	freshProcess: boolean | null;
	errors: string[];
};

/** 빈 diagnostic payload를 생성합니다. */
export function createEmptyDiagnostics(partial: Partial<VerificationDiagnostics> = {}): VerificationDiagnostics {
	return {
		repositoryVersion: null,
		lockVersion: null,
		installedVersion: null,
		repositoryBundle: null,
		installedBundle: null,
		installedRealpath: null,
		bundleChecksumMatch: null,
		requestedRoots: [],
		queriedRoots: [],
		indexed: null,
		parsed: null,
		discoveredNames: [],
		resolvedNames: [],
		missingNames: [],
		freshProcess: null,
		errors: [],
		...partial,
	};
}

/** diagnostic 필드를 한 화면 텍스트로 직렬화합니다. */
export function formatDiagnostics(diagnostics: VerificationDiagnostics): string {
	const lines = [
		`repositoryVersion=${diagnostics.repositoryVersion ?? "-"}`,
		`lockVersion=${diagnostics.lockVersion ?? "-"}`,
		`installedVersion=${diagnostics.installedVersion ?? "-"}`,
		`repositoryBundle=${diagnostics.repositoryBundle ?? "-"}`,
		`installedBundle=${diagnostics.installedBundle ?? "-"}`,
		`installedRealpath=${diagnostics.installedRealpath ?? "-"}`,
		`bundleChecksumMatch=${diagnostics.bundleChecksumMatch ?? "-"}`,
		`requestedRoots=${JSON.stringify(diagnostics.requestedRoots)}`,
		`queriedRoots=${JSON.stringify(diagnostics.queriedRoots)}`,
		`indexed=${diagnostics.indexed ?? "-"}`,
		`parsed=${diagnostics.parsed ?? "-"}`,
		`discoveredNames=${JSON.stringify(diagnostics.discoveredNames)}`,
		`resolvedNames=${JSON.stringify(diagnostics.resolvedNames)}`,
		`missingNames=${JSON.stringify(diagnostics.missingNames)}`,
		`freshProcess=${diagnostics.freshProcess ?? "-"}`,
	];
	if (diagnostics.errors.length > 0) {
		lines.push("errors:");
		for (const error of diagnostics.errors) {
			lines.push(`  - ${error}`);
		}
	}
	return lines.join("\n");
}

/** verification 실패를 diagnostic과 함께 표현하는 오류입니다. */
export class VerificationFailure extends Error {
	readonly diagnostics: VerificationDiagnostics;

	constructor(message: string, diagnostics: VerificationDiagnostics) {
		super(message);
		this.name = "VerificationFailure";
		this.diagnostics = diagnostics;
	}
}
