import { describe, expect, jest, test } from "@jest/globals";
import type { SkillIndexDiagnostics } from "../indexing/skill-index-diagnostics";
import type { SkillIndexLoader } from "../indexing/skill-index-loader";
import type { SkillInputNormalizer } from "../indexing/skill-input-normalizer";
import type { IndexArtifacts, ToolContext } from "../shared";
import { DiagnosticsCommandService } from "./diagnostics-command.service";

jest.mock("../results", () => ({
	buildAuditResult: jest.fn().mockReturnValue({
		content: [{ type: "text", text: "audit passed" }],
		details: { issues: [] },
	}),
	buildValidateResult: jest.fn().mockReturnValue({
		content: [{ type: "text", text: "validation success" }],
		details: { valid: true },
	}),
	buildMetricsResult: jest.fn().mockReturnValue({
		content: [{ type: "text", text: "metrics summary" }],
		details: { count: 42 },
	}),
}));

describe("DiagnosticsCommandService", () => {
	test("should return success status and grouped details from audit, validation, and metrics", async () => {
		const mockNormalizeToolInput = jest.fn<(params: unknown) => ToolContext>().mockReturnValue({
			action: "audit",
			limit: 10,
			minScore: 0.1,
		} as unknown as ToolContext);

		const mockIndex = {} as unknown as IndexArtifacts;
		const mockLoadIndex = jest.fn<(context: ToolContext) => Promise<IndexArtifacts>>().mockResolvedValue(mockIndex);

		const mockAuditSkills = jest.fn().mockReturnValue([]);
		const mockValidateIndex = jest.fn().mockReturnValue({ errors: [] });

		const deps = {
			inputNormalizer: { normalizeToolInput: mockNormalizeToolInput } as unknown as SkillInputNormalizer,
			indexLoader: { loadIndex: mockLoadIndex } as unknown as SkillIndexLoader,
			indexDiagnostics: {
				auditSkills: mockAuditSkills,
				validateIndex: mockValidateIndex,
			} as unknown as SkillIndexDiagnostics,
		};

		const service = new DiagnosticsCommandService(deps);
		const result = await service.execute({ args: "" });

		expect(mockNormalizeToolInput).toHaveBeenCalledWith({ action: "audit" });
		expect(mockLoadIndex).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "audit",
				limit: 10,
				minScore: 0.1,
			}),
		);
		expect(mockAuditSkills).toHaveBeenCalledWith(mockIndex, undefined, [], 10, 0.1);
		expect(mockValidateIndex).toHaveBeenCalledWith(mockIndex);

		expect(result).toEqual({
			kind: "diagnostics",
			status: "success",
			message: "audit passed\n\nskill_registry validate 결과\n\nskill_registry metrics summary",
			details: {
				audit: { issues: [] },
				validation: { valid: true },
				metrics: { count: 42 },
			},
		});
	});

	test("should return diagnostics error status if loading index fails", async () => {
		const mockNormalizeToolInput = jest.fn<(params: unknown) => ToolContext>().mockReturnValue({
			action: "audit",
		} as unknown as ToolContext);
		const mockLoadIndex = jest
			.fn<(context: ToolContext) => Promise<IndexArtifacts>>()
			.mockRejectedValue(new Error("Index loader failed"));

		const deps = {
			inputNormalizer: { normalizeToolInput: mockNormalizeToolInput } as unknown as SkillInputNormalizer,
			indexLoader: { loadIndex: mockLoadIndex } as unknown as SkillIndexLoader,
			indexDiagnostics: {
				auditSkills: jest.fn(),
				validateIndex: jest.fn(),
			} as unknown as SkillIndexDiagnostics,
		};

		const service = new DiagnosticsCommandService(deps);
		const result = await service.execute({ args: "" });

		expect(result).toEqual({
			kind: "diagnostics",
			status: "error",
			message: "diagnostics 실행 오류: Index loader failed. skill roots와 index 설정을 확인한 후 다시 시도하십시오.",
		});
	});
});
