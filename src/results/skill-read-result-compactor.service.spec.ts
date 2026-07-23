import { describe, expect, test } from "@jest/globals";
import type { SkillReadResultCompactorToolResult } from "./skill-read-result-compactor.interface";
import { SkillReadResultCompactorService } from "./skill-read-result-compactor.service";

function makeToolResult(overrides: Partial<SkillReadResultCompactorToolResult> = {}): SkillReadResultCompactorToolResult {
	return {
		toolName: "read",
		isError: true,
		input: {
			path: "skill://alpha",
		},
		content: [
			{
				type: "text",
				text: "Unknown skill: alpha\nAvailable: beta, gamma",
			},
		],
		...overrides,
	};
}

describe("SkillReadResultCompactorService", () => {
	test("returns a compact recovery replacement for exact unknown skill matches", () => {
		const service = new SkillReadResultCompactorService();
		const result = service.handleToolResult(makeToolResult());

		expect(result).toEqual({
			isError: false,
			content: [{ type: "text", text: expect.stringContaining("Unknown skill: alpha") }],
		});
		expect(result?.content[0]?.text ?? "").not.toContain("Available:");
		expect(result?.content[0]?.text ?? "").not.toContain("beta");
		expect(result?.content[0]?.text ?? "").not.toContain("gamma");
	});

	test("passes through non-read, non-skill, false error, missing Unknown prefix, missing Available section, malformed input, and missing text", () => {
		const service = new SkillReadResultCompactorService();
		const cases = [
			makeToolResult({ toolName: "other" }),
			makeToolResult({ input: { path: "file:///tmp/alpha" } }),
			makeToolResult({ isError: false }),
			makeToolResult({ content: [{ type: "text", text: "skill lookup failed\nAvailable: beta" }] }),
			makeToolResult({ content: [{ type: "text", text: "Unknown skill: alpha" }] }),
			makeToolResult({ input: null }),
			makeToolResult({ content: [] }),
		];

		for (const toolResult of cases) {
			expect(service.handleToolResult(toolResult)).toBeUndefined();
		}
	});

	test("sanitizes CR LF and control characters", () => {
		const service = new SkillReadResultCompactorService();
		const result = service.handleToolResult(
			makeToolResult({
				input: { path: "skill://al\r\npha\u0000\u0007" },
			}),
		);

		const text = result?.content[0]?.text ?? "";
		expect(text).toContain("Unknown skill: alpha");
		expect(text).not.toContain("\r");
		expect(text).not.toContain("\u0000");
		expect(text).not.toContain("\u0007");
	});

	test("decodes unicode and percent-encoded names and truncates long names", () => {
		const service = new SkillReadResultCompactorService();
		const encoded = service.handleToolResult(
			makeToolResult({
				input: { path: "skill://%E2%9C%93%20%EA%B8%B0%EC%88%A0" },
			}),
		);
		expect(encoded?.content[0]?.text ?? "").toContain("Unknown skill: ✓ 기술");

		const longName = `${"ä".repeat(10_000)}%20tail`;
		const longResult = service.handleToolResult(
			makeToolResult({
				input: { path: `skill://${longName}` },
			}),
		);
		const longText = longResult?.content[0]?.text ?? "";
		expect(new TextEncoder().encode(longText).byteLength).toBeLessThanOrEqual(4096);
		expect(longText).not.toContain("%20");
	});

	test("handles multipart names and keeps output bounded", () => {
		const service = new SkillReadResultCompactorService();
		const result = service.handleToolResult(
			makeToolResult({
				input: { path: "skill://alpha/beta/gamma" },
			}),
		);

		const text = result?.content[0]?.text ?? "";
		expect(text).toContain("Unknown skill: alpha/beta/gamma");
		expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(4096);
	});
});
