import { describe, expect, jest, test } from "@jest/globals";
import type { IndexArtifacts, SkillCurrentTurnPacketResult, SkillTurnPacketTurn } from "../shared";
import { SkillExecutionPacketBuilder } from "./skill-execution-packet-builder";
import type { SkillReadPacketBuilder } from "./skill-read-packet-builder";

/**
 * IndexArtifacts fixture가 재사용할 유효한 64-hex sourceSignature입니다.
 */
const VALID_SOURCE_SIGNATURE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const baseTurn: SkillTurnPacketTurn = {
	order: 2,
	phaseKind: "read-layer",
	layer: 1,
	names: ["alpha", "beta"],
	readPaths: ["/tmp/alpha.md", "/tmp/beta.md"],
	sourcePaths: ["/tmp/alpha.md", "/tmp/beta.md"],
	nextCommands: ['read("/tmp/alpha.md")', 'read("/tmp/beta.md")'],
	objective: "Inspect layered read paths before applying next steps.",
	checklist: ["Resolve direct dependencies before optional extension.", "Validate checklist ordering in generated packets."],
	exitCriteria: ["Dependency skills are fully reviewed.", "No omitted read bodies remain."],
	blockedByBudget: false,
};

const baseBudget = {
	requestedChars: 1_024,
	requestedTokens: 256,
	effectiveChars: 512,
	usedChars: 128,
};

function makeTurnPacket(overrides: Partial<SkillCurrentTurnPacketResult> = {}): SkillCurrentTurnPacketResult {
	return {
		query: "execution-query",
		basis: "query+names",
		relationMode: "full",
		winner: "alpha",
		ready: false,
		applyHint: "Increase budget before apply.",
		recoveryGuidance: ["Read required paths first."],
		omittedReadPaths: ["/tmp/omit.md"],
		recoveryCommands: ['read("/tmp/omit.md")'],
		sourcePaths: ["/tmp/alpha.md", "/tmp/beta.md"],
		nextCommands: [...baseTurn.nextCommands],
		deferred: ["fallback", "optional-extra"],
		activeTurnOrder: baseTurn.order,
		budget: { ...baseBudget },
		turn: { ...baseTurn },
		blockedTurns: [],
		...overrides,
	};
}

function makeBuilderStub(currentTurn: SkillCurrentTurnPacketResult): {
	index: IndexArtifacts;
	readBuilder: SkillReadPacketBuilder;
	currentTurnPacketSkills: jest.Mock;
} {
	const currentTurnPacketSkills = jest.fn(() => currentTurn);
	currentTurnPacketSkills.mockReturnValue(currentTurn);
	return {
		index: { sourceSignature: VALID_SOURCE_SIGNATURE } as IndexArtifacts,
		readBuilder: {
			currentTurnPacketSkills,
		} as unknown as SkillReadPacketBuilder,
		currentTurnPacketSkills,
	};
}

describe("skill-execution-packet-builder", () => {
	test("formats instruction and checklist strings in stable turn order", () => {
		const { index, readBuilder, currentTurnPacketSkills } = makeBuilderStub(makeTurnPacket());
		const builder = new SkillExecutionPacketBuilder(readBuilder);

		const instructionPacket = builder.instructionPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 777, 199, 9, 0.2);

		expect(currentTurnPacketSkills).toHaveBeenCalledTimes(1);
		expect(currentTurnPacketSkills).toHaveBeenCalledWith(index, "execution-query", ["alpha", "beta"], "full", 777, 199, 9, 0.2);

		const expectedChecklistText = [
			"1. Resolve direct dependencies before optional extension.",
			"2. Validate checklist ordering in generated packets.",
		].join("\n");

		expect(instructionPacket.checklistText).toBe(expectedChecklistText);
		expect(instructionPacket.commandBlock).toBe('read("/tmp/alpha.md")\nread("/tmp/beta.md")');
		expect(instructionPacket.instructionText).toBe(
			[
				"Focus on turn 2 (read-layer:1).",
				"Read skills: alpha, beta.",
				"Inspect layered read paths before applying next steps.",
				'Commands:\nread("/tmp/alpha.md")\nread("/tmp/beta.md")',
				"Checklist:\n1. Resolve direct dependencies before optional extension.\n2. Validate checklist ordering in generated packets.",
			].join("\n"),
		);
	});

	test("renders markdown packet with section ordering and checklist item order", () => {
		const { index, readBuilder } = makeBuilderStub(makeTurnPacket());
		const builder = new SkillExecutionPacketBuilder(readBuilder);
		const instructionPacket = builder.instructionPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 512, 128, 4, 0.1);
		const markdownPacket = builder.markdownPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 512, 128, 4, 0.1);

		expect(markdownPacket.checklistItems).toEqual([
			"1. Resolve direct dependencies before optional extension.",
			"2. Validate checklist ordering in generated packets.",
		]);
		expect(markdownPacket.markdown).toBe(
			[
				`# alpha turn 2`,
				"",
				"## Summary",
				instructionPacket.instructionText,
				"",
				"## Commands",
				instructionPacket.commandBlock,
				"",
				"## Checklist",
				"- 1. Resolve direct dependencies before optional extension.\n- 2. Validate checklist ordering in generated packets.",
				"",
				"## Recovery",
				instructionPacket.recoveryGuidance.length ? instructionPacket.recoveryGuidance.map((item) => `- ${item}`).join("\n") : "-",
			].join("\n"),
		);
	});

	test("derives file-ready payloads with compact source order and checklist serialization", () => {
		const { index, readBuilder } = makeBuilderStub(makeTurnPacket());
		const builder = new SkillExecutionPacketBuilder(readBuilder);
		const fileReadyPacket = builder.fileReadyPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 777, 199, 9, 0.2);

		const baseName = "alpha-turn-2";
		expect(fileReadyPacket.baseName).toBe(baseName);
		expect(fileReadyPacket.files).toEqual([
			{
				kind: "markdown",
				suggestedPath: `packets/${baseName}.md`,
				mediaType: "text/markdown",
				content: expect.stringContaining("## Summary"),
			},
			{
				kind: "checklist",
				suggestedPath: `packets/${baseName}.checklist.md`,
				mediaType: "text/markdown",
				content: "- Resolve direct dependencies before optional extension.\n- Validate checklist ordering in generated packets.",
			},
			{
				kind: "commands",
				suggestedPath: `packets/${baseName}.commands.txt`,
				mediaType: "text/plain",
				content: 'read("/tmp/alpha.md")\nread("/tmp/beta.md")',
			},
		]);
		expect(fileReadyPacket.sourcePaths).toEqual(["/tmp/alpha.md", "/tmp/beta.md"]);
		expect(fileReadyPacket.budget).toEqual(baseBudget);
	});

	test("serializes apply packets and write scripts with write order preserved", () => {
		const { index, readBuilder } = makeBuilderStub(makeTurnPacket());
		const builder = new SkillExecutionPacketBuilder(readBuilder);
		const fileReadyPacket = builder.fileReadyPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 777, 199, 9, 0.2);
		const applyPacket = builder.applyPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 777, 199, 9, 0.2);

		const expectedWrites = fileReadyPacket.files.map((file) => ({
			kind: "write" as const,
			sourceKind: file.kind,
			path: file.suggestedPath,
			mediaType: file.mediaType,
			content: file.content,
		}));

		expect(applyPacket.writes).toEqual(expectedWrites);
		expect(applyPacket.applyText).toBe(
			[
				"1. write packets/alpha-turn-2.md (markdown)",
				"2. write packets/alpha-turn-2.checklist.md (checklist)",
				"3. write packets/alpha-turn-2.commands.txt (commands)",
			].join("\n"),
		);

		const writeScriptPacket = builder.writeScriptPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 777, 199, 9, 0.2);
		expect(writeScriptPacket.scriptPath).toBe("packets/alpha-turn-2.write.ts");
		expect(writeScriptPacket.commandBlock).toBe("bun packets/alpha-turn-2.write.ts");
		expect(writeScriptPacket.writes).toEqual(expectedWrites);
		expect(writeScriptPacket.scriptContent).toContain(`const writes = ${JSON.stringify(expectedWrites, null, 2)} as const;`);
		expect(writeScriptPacket.scriptContent).toContain("await Bun.write(write.path, write.content);");
	});

	test("projects execution and verification packets with ordered run/verify content", () => {
		const { index, readBuilder } = makeBuilderStub(makeTurnPacket());
		const builder = new SkillExecutionPacketBuilder(readBuilder);
		const executionPacket = builder.executionPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 777, 199, 9, 0.2);
		const verificationPacket = builder.verificationPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 777, 199, 9, 0.2);

		expect(executionPacket.runCommands).toEqual(["bun packets/alpha-turn-2.write.ts"]);
		expect(executionPacket.files).toEqual([
			{
				kind: "script",
				path: "packets/alpha-turn-2.write.ts",
				mediaType: "text/typescript",
				content: expect.any(String),
			},
		]);
		expect(executionPacket.executionText).toBe(
			[
				"1. Write script file: packets/alpha-turn-2.write.ts",
				"2. Run command: bun packets/alpha-turn-2.write.ts",
				"3. Expect 3 file write operations.",
			].join("\n"),
		);

		expect(verificationPacket.verificationCommands).toEqual(["bun packets/alpha-turn-2.write.ts"]);
		expect(verificationPacket.verificationItems).toEqual(["Dependency skills are fully reviewed.", "No omitted read bodies remain."]);
		expect(verificationPacket.verificationText).toBe(
			[
				"Run:",
				"bun packets/alpha-turn-2.write.ts",
				"",
				"Verify:",
				"1. Dependency skills are fully reviewed.\n2. No omitted read bodies remain.",
			].join("\n"),
		);
	});

	test("propagates non-default args and reuses budget across chained packet builders", () => {
		const readPacket = makeTurnPacket();
		const { index, readBuilder, currentTurnPacketSkills } = makeBuilderStub(readPacket);
		const builder = new SkillExecutionPacketBuilder(readBuilder);
		const invocationArgs: Parameters<SkillExecutionPacketBuilder["instructionPacketSkills"]> = [
			index,
			"budget-query",
			["alpha", "beta"],
			"required",
			4096,
			333,
			17,
			0.42,
		];
		const instructionPacket = builder.instructionPacketSkills(...invocationArgs);
		const markdownPacket = builder.markdownPacketSkills(...invocationArgs);
		const checklistPacket = builder.checklistPacketSkills(...invocationArgs);
		const commandsPacket = builder.commandsPacketSkills(...invocationArgs);
		const fileReadyPacket = builder.fileReadyPacketSkills(...invocationArgs);
		const applyPacket = builder.applyPacketSkills(...invocationArgs);
		const writeScriptPacket = builder.writeScriptPacketSkills(...invocationArgs);
		const executionPacket = builder.executionPacketSkills(...invocationArgs);
		const verificationPacket = builder.verificationPacketSkills(...invocationArgs);

		expect(currentTurnPacketSkills).toHaveBeenCalledTimes(19);
		for (const call of currentTurnPacketSkills.mock.calls) {
			expect(call).toEqual([index, "budget-query", ["alpha", "beta"], "required", 4096, 333, 17, 0.42]);
		}
		for (const packet of [
			instructionPacket,
			markdownPacket,
			checklistPacket,
			commandsPacket,
			fileReadyPacket,
			applyPacket,
			writeScriptPacket,
			executionPacket,
			verificationPacket,
		]) {
			expect(packet.budget).toEqual(readPacket.budget);
		}

		expect(fileReadyPacket.baseName).toBe("alpha-turn-2");
		expect(commandsPacket.commandBlock).toBe('read("/tmp/alpha.md")\nread("/tmp/beta.md")');
	});

	test("falls back to generic verification item when turn lacks exit criteria", () => {
		const packetWithoutTurn = makeTurnPacket({
			turn: null,
		});
		const { index, readBuilder } = makeBuilderStub(packetWithoutTurn);
		const builder = new SkillExecutionPacketBuilder(readBuilder);
		const verificationPacket = builder.verificationPacketSkills(index, "execution-query", ["alpha", "beta"], "full", 777, 199, 9, 0.2);

		expect(verificationPacket.verificationItems).toEqual(["Run command completed without write errors."]);
		expect(verificationPacket.verificationCommands).toEqual(["bun packets/alpha-turn-2.write.ts"]);
		expect(verificationPacket.verificationText).toBe(
			["Run:", "bun packets/alpha-turn-2.write.ts", "", "Verify:\n1. Run command completed without write errors."].join("\n"),
		);
	});
});
