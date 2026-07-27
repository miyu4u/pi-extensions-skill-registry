import { describe, expect, jest, test } from "@jest/globals";
import type { SkillIndexLoader } from "../indexing/skill-index-loader";
import type { SkillInputNormalizer } from "../indexing/skill-input-normalizer";
import type { IndexArtifacts, ToolContext } from "../shared";

jest.unstable_mockModule("../results", () => ({
	buildIndexResult: jest.fn().mockReturnValue({
		content: [{ type: "text", text: "skill_registry index 완료" }],
		details: { mocked: true },
	}),
}));

// Static import cannot work because Jest ESM requires dynamic import after jest.unstable_mockModule
const { ReindexCommandService } = await import("./reindex-command.service");

describe("ReindexCommandService", () => {
	test("should perform a forced refresh by passing refresh true and return success status", async () => {
		const mockNormalizeToolInput = jest.fn<(params: unknown) => ToolContext>().mockReturnValue({
			action: "index",
			limit: 10,
			refresh: true,
		} as unknown as ToolContext);

		const mockLoadIndex = jest
			.fn<(context: ToolContext) => Promise<IndexArtifacts>>()
			.mockResolvedValue({} as unknown as IndexArtifacts);

		const deps = {
			inputNormalizer: { normalizeToolInput: mockNormalizeToolInput } as unknown as SkillInputNormalizer,
			indexLoader: { loadIndex: mockLoadIndex } as unknown as SkillIndexLoader,
		};

		const service = new ReindexCommandService(deps);
		const result = await service.execute({ args: "" });

		expect(mockNormalizeToolInput).toHaveBeenCalledWith({
			action: "index",
			refresh: true,
		});
		expect(mockLoadIndex).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "index",
				refresh: true,
			}),
		);

		expect(result).toEqual({
			kind: "reindex",
			status: "success",
			message: "skill_registry index 완료",
			details: { mocked: true },
		});
	});

	test("should handle index loader errors gracefully and return error status", async () => {
		const mockNormalizeToolInput = jest.fn<(params: unknown) => ToolContext>().mockReturnValue({
			action: "index",
			limit: 10,
			refresh: true,
		} as unknown as ToolContext);

		const mockLoadIndex = jest
			.fn<(context: ToolContext) => Promise<IndexArtifacts>>()
			.mockRejectedValue(new Error("File system permission denied"));

		const deps = {
			inputNormalizer: { normalizeToolInput: mockNormalizeToolInput } as unknown as SkillInputNormalizer,
			indexLoader: { loadIndex: mockLoadIndex } as unknown as SkillIndexLoader,
		};

		const service = new ReindexCommandService(deps);
		const result = await service.execute({ args: "" });

		expect(result).toEqual({
			kind: "reindex",
			status: "error",
			message: "reindex 실행 오류: File system permission denied. 설정 파일과 디렉토리 권한을 확인한 후 다시 시도하십시오.",
		});
	});
});
