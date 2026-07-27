import path from "node:path";
import { KNOWN_PLANNING_CANONICALS, PLANNING_DISCOVER_QUERY, PLANNING_RESOLVE_ORDER } from "./constants";
import { createEmptyDiagnostics, type VerificationDiagnostics, VerificationFailure } from "./diagnostics";
import type { CapturedSkillRegistryExecute, CapturedToolResult } from "./dist-harness";

/** planning corpus contract 실행 옵션입니다. */
export type PlanningContractOptions = {
	execute: CapturedSkillRegistryExecute;
	roots: string[];
	/** true면 known canonical 전부 resolve 성공을 요구합니다. fixture는 true, operator smoke도 true. */
	requireExactKnownResolve?: boolean;
};

/** planning contract 실행 결과입니다. */
export type PlanningContractResult = {
	diagnostics: VerificationDiagnostics;
};

/**
 * discover → explicit-root index → known canonical resolve 경로를
 * structured details만으로 검증합니다.
 */
export async function runPlanningCorpusContract(options: PlanningContractOptions): Promise<PlanningContractResult> {
	const requireExactKnownResolve = options.requireExactKnownResolve ?? true;
	const requestedRoots = options.roots.map((root) => path.resolve(root));
	const diagnostics = createEmptyDiagnostics({
		requestedRoots,
	});

	const discoverResult = await options.execute("verify-discover", {
		action: "discover",
		query: PLANNING_DISCOVER_QUERY,
		roots: requestedRoots,
		fileNames: ["SKILL.md"],
		refresh: true,
		limit: 20,
	});
	assertToolOk(discoverResult, "discover", diagnostics);
	const discovered = readArray<{ name?: string }>(discoverResult.details, "discovered");
	diagnostics.discoveredNames = discovered.map((entry) => String(entry.name ?? "")).filter(Boolean);
	if (diagnostics.discoveredNames.length < 1) {
		fail("planning discover returned 0 skills", diagnostics);
	}

	const indexResult = await options.execute("verify-index", {
		action: "index",
		roots: requestedRoots,
		fileNames: ["SKILL.md"],
		refresh: true,
	});
	assertToolOk(indexResult, "index", diagnostics);
	const indexed = readNumber(indexResult.details, "docCount");
	const parsed = readNestedNumber(indexResult.details, ["stats", "totalParsed"]);
	const queriedRoots = readStringArray(indexResult.details, "queriedRoots");
	diagnostics.indexed = indexed;
	diagnostics.parsed = parsed;
	diagnostics.queriedRoots = queriedRoots;

	if (indexed === null || indexed < 1) {
		fail(`explicit-root index indexed=${indexed} expected > 0`, diagnostics);
	}
	if (parsed === null || parsed < 1) {
		fail(`explicit-root index parsed=${parsed} expected > 0`, diagnostics);
	}
	if (!samePathSet(queriedRoots, requestedRoots)) {
		fail("queriedRoots did not match requestedRoots exactly", diagnostics);
	}

	const resolveResult = await options.execute("verify-resolve", {
		action: "resolve",
		names: [...PLANNING_RESOLVE_ORDER],
		roots: requestedRoots,
		fileNames: ["SKILL.md"],
		refresh: false,
		includeBody: false,
	});
	assertToolOk(resolveResult, "resolve", diagnostics);
	const resolved = readArray<{ name?: string }>(resolveResult.details, "resolved");
	const missing = readStringArray(resolveResult.details, "missing");
	diagnostics.resolvedNames = resolved.map((entry) => String(entry.name ?? "")).filter(Boolean);
	diagnostics.missingNames = missing;

	if (requireExactKnownResolve) {
		if (diagnostics.resolvedNames.length !== PLANNING_RESOLVE_ORDER.length) {
			fail(`resolve count ${diagnostics.resolvedNames.length} != ${PLANNING_RESOLVE_ORDER.length}`, diagnostics);
		}
		if (!arraysEqual(diagnostics.resolvedNames, [...PLANNING_RESOLVE_ORDER])) {
			fail("resolve order did not match request order", diagnostics);
		}
		if (diagnostics.missingNames.length !== 0) {
			fail("resolve missing names must be empty", diagnostics);
		}
		for (const name of KNOWN_PLANNING_CANONICALS) {
			if (!diagnostics.resolvedNames.includes(name)) {
				fail(`known planning canonical missing from resolve: ${name}`, diagnostics);
			}
		}
	}

	return { diagnostics };
}

/** tool result에 error details가 없는지 확인하고 실패 시 diagnostic에 남깁니다. */
function assertToolOk(result: CapturedToolResult, action: string, diagnostics: VerificationDiagnostics): void {
	const kind = typeof result.details?.kind === "string" ? result.details.kind : undefined;
	if (kind === "error" || !result.details) {
		const text = result.content.find((item) => item.type === "text")?.text ?? "(no text)";
		fail(`${action} returned error or missing details: ${text}`, diagnostics);
	}
}

function fail(message: string, diagnostics: VerificationDiagnostics): never {
	diagnostics.errors.push(message);
	throw new VerificationFailure(message, diagnostics);
}

function readArray<T>(details: Record<string, unknown> | undefined, key: string): T[] {
	const value = details?.[key];
	return Array.isArray(value) ? (value as T[]) : [];
}

function readStringArray(details: Record<string, unknown> | undefined, key: string): string[] {
	const value = details?.[key];
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((entry) => String(entry));
}

function readNumber(details: Record<string, unknown> | undefined, key: string): number | null {
	const value = details?.[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readNestedNumber(details: Record<string, unknown> | undefined, pathKeys: string[]): number | null {
	let current: unknown = details;
	for (const key of pathKeys) {
		if (!current || typeof current !== "object") {
			return null;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return typeof current === "number" && Number.isFinite(current) ? current : null;
}

function arraysEqual(left: string[], right: string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	return left.every((value, index) => value === right[index]);
}

function samePathSet(left: string[], right: string[]): boolean {
	if (left.length !== right.length) {
		return false;
	}
	const normalizedLeft = [...left.map((value) => path.resolve(value))].sort();
	const normalizedRight = [...right.map((value) => path.resolve(value))].sort();
	return arraysEqual(normalizedLeft, normalizedRight);
}
