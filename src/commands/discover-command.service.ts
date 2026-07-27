import type { SkillIndexLoader } from "../indexing/skill-index-loader";
import type { SkillInputNormalizer } from "../indexing/skill-input-normalizer";
import type { SkillSearchEngine } from "../indexing/skill-search-engine";
import { buildDiscoverResult } from "../results";
import type { RegistryCommandContract } from "./registry-command.interface";
import type { RegistryCommandRequest, RegistryCommandResult } from "./registry-command.schema";

/**
 * DiscoverCommandService가 요구하는 의존성 명세입니다.
 */
export interface DiscoverCommandDependencies {
	inputNormalizer: Pick<SkillInputNormalizer, "normalizeToolInput">;
	indexLoader: Pick<SkillIndexLoader, "loadIndex">;
	searchEngine: Pick<SkillSearchEngine, "searchWithDiagnostics">;
}

/**
 * 검색어를 기반으로 매칭되는 skill들을 탐색하여 그 결과를 반환하는 slash command service 구현체입니다.
 */
export class DiscoverCommandService implements RegistryCommandContract {
	constructor(private readonly deps: DiscoverCommandDependencies) {}

	async execute(request: RegistryCommandRequest): Promise<RegistryCommandResult> {
		try {
			const query = request.args.trim();
			if (!query) {
				return {
					kind: "discover",
					status: "error",
					message: "discover 실행 오류: 검색어가 비어 있습니다.",
				};
			}

			const normalized = this.deps.inputNormalizer.normalizeToolInput({
				action: "discover",
				query,
			});

			const index = await this.deps.indexLoader.loadIndex(normalized);

			const searchResult = this.deps.searchEngine.searchWithDiagnostics(
				index,
				normalized.query ?? query,
				normalized.limit,
				normalized.minScore,
			);

			const result = buildDiscoverResult(index, searchResult.hits, normalized, searchResult.diagnostics);
			const textContent = result.content.find((c) => c.type === "text")?.text;

			if (!textContent) {
				return {
					kind: "discover",
					status: "error",
					message: "discover 실행 오류: 결과를 텍스트 형식으로 변환할 수 없습니다.",
				};
			}

			return {
				kind: "discover",
				status: "success",
				message: textContent,
				details: result.details,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				kind: "discover",
				status: "error",
				message: `discover 실행 오류: ${message}`,
			};
		}
	}
}
