import type {
	IndexArtifacts,
	SkillApplyPacketResult,
	SkillChecklistPacketResult,
	SkillCommandsPacketResult,
	SkillExecutionPacketResult,
	SkillFileReadyPacketResult,
	SkillInstructionPacketResult,
	SkillMarkdownPacketResult,
	SkillRelationMode,
	SkillSummaryPacketResult,
	SkillVerificationPacketResult,
	SkillWriteScriptPacketResult,
} from "../shared";
import type { SkillReadPacketBuilder } from "./skill-read-packet-builder";

/** serialization/execution packet projection의 concrete owner입니다. */
export class SkillExecutionPacketBuilder {
	constructor(private readonly readPacketBuilder: SkillReadPacketBuilder) {}

	/**
	 * current turn을 prompt-ready 실행 지시문으로 직렬화합니다.
	 */
	instructionPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillInstructionPacketResult {
		const currentTurnPacket = this.readPacketBuilder.currentTurnPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const turn = currentTurnPacket.turn;
		const checklistText = turn?.checklist.length ? turn.checklist.map((item, idx) => `${idx + 1}. ${item}`).join("\n") : "";
		const commandBlock = currentTurnPacket.nextCommands.join("\n");
		const instructionText = turn
			? [
					`Focus on turn ${turn.order} (${turn.phaseKind}${turn.layer !== null ? `:${turn.layer}` : ""}).`,
					`Read skills: ${turn.names.join(", ")}.`,
					turn.objective,
					commandBlock ? `Commands:\n${commandBlock}` : "Commands: -",
					checklistText ? `Checklist:\n${checklistText}` : "Checklist: -",
				].join("\n")
			: "No active turn is available.";
		return {
			query: currentTurnPacket.query,
			basis: currentTurnPacket.basis,
			relationMode: currentTurnPacket.relationMode,
			winner: currentTurnPacket.winner,
			ready: currentTurnPacket.ready,
			applyHint: currentTurnPacket.applyHint,
			recoveryGuidance: currentTurnPacket.recoveryGuidance,
			activeTurnOrder: currentTurnPacket.activeTurnOrder,
			sourcePaths: currentTurnPacket.sourcePaths,
			nextCommands: currentTurnPacket.nextCommands,
			instructionText,
			checklistText,
			commandBlock,
			budget: currentTurnPacket.budget,
			turn,
		};
	}

	/**
	 * current turn을 summary 문장으로 직렬화합니다.
	 */
	summaryPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillSummaryPacketResult {
		const currentTurnPacket = this.readPacketBuilder.currentTurnPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const turn = currentTurnPacket.turn;
		const summaryText = turn
			? `${currentTurnPacket.winner ?? "skill"} turn ${turn.order}: ${turn.objective}. commands=${turn.nextCommands.length}, checklist=${turn.checklist.length}`
			: "No active turn is available.";
		return {
			query: currentTurnPacket.query,
			basis: currentTurnPacket.basis,
			relationMode: currentTurnPacket.relationMode,
			winner: currentTurnPacket.winner,
			ready: currentTurnPacket.ready,
			applyHint: currentTurnPacket.applyHint,
			recoveryGuidance: currentTurnPacket.recoveryGuidance,
			activeTurnOrder: currentTurnPacket.activeTurnOrder,
			sourcePaths: currentTurnPacket.sourcePaths,
			nextCommands: currentTurnPacket.nextCommands,
			summaryText,
			budget: currentTurnPacket.budget,
			turn,
		};
	}

	/**
	 * current turn을 markdown checklist/command 문서로 직렬화합니다.
	 */
	markdownPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillMarkdownPacketResult {
		const instructionPacket = this.instructionPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const checklistItems = instructionPacket.checklistText ? instructionPacket.checklistText.split("\n") : [];
		const markdown = [
			`# ${instructionPacket.winner ?? "skill"} turn ${instructionPacket.activeTurnOrder ?? "-"}`,
			"",
			"## Summary",
			instructionPacket.instructionText,
			"",
			"## Commands",
			instructionPacket.commandBlock || "-",
			"",
			"## Checklist",
			checklistItems.length ? checklistItems.map((item) => `- ${item}`).join("\n") : "-",
			"",
			"## Recovery",
			instructionPacket.recoveryGuidance.length ? instructionPacket.recoveryGuidance.map((item) => `- ${item}`).join("\n") : "-",
		].join("\n");
		return {
			query: instructionPacket.query,
			basis: instructionPacket.basis,
			relationMode: instructionPacket.relationMode,
			winner: instructionPacket.winner,
			ready: instructionPacket.ready,
			applyHint: instructionPacket.applyHint,
			recoveryGuidance: instructionPacket.recoveryGuidance,
			activeTurnOrder: instructionPacket.activeTurnOrder,
			sourcePaths: instructionPacket.sourcePaths,
			nextCommands: instructionPacket.nextCommands,
			markdown,
			commandBlock: instructionPacket.commandBlock,
			checklistItems,
			budget: instructionPacket.budget,
			turn: instructionPacket.turn,
		};
	}

	/**
	 * current turn에서 checklist 전용 packet만 추출합니다.
	 */
	checklistPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillChecklistPacketResult {
		const currentTurnPacket = this.readPacketBuilder.currentTurnPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const turn = currentTurnPacket.turn;
		const checklistItems = turn?.checklist ?? [];
		const checklistText = checklistItems.length ? checklistItems.map((item, idx) => `${idx + 1}. ${item}`).join("\n") : "";
		return {
			query: currentTurnPacket.query,
			basis: currentTurnPacket.basis,
			relationMode: currentTurnPacket.relationMode,
			winner: currentTurnPacket.winner,
			ready: currentTurnPacket.ready,
			applyHint: currentTurnPacket.applyHint,
			recoveryGuidance: currentTurnPacket.recoveryGuidance,
			activeTurnOrder: currentTurnPacket.activeTurnOrder,
			sourcePaths: currentTurnPacket.sourcePaths,
			nextCommands: currentTurnPacket.nextCommands,
			checklistItems,
			checklistText,
			budget: currentTurnPacket.budget,
			turn,
		};
	}

	/**
	 * current turn에서 command 전용 packet만 추출합니다.
	 */
	commandsPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillCommandsPacketResult {
		const currentTurnPacket = this.readPacketBuilder.currentTurnPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		return {
			query: currentTurnPacket.query,
			basis: currentTurnPacket.basis,
			relationMode: currentTurnPacket.relationMode,
			winner: currentTurnPacket.winner,
			ready: currentTurnPacket.ready,
			applyHint: currentTurnPacket.applyHint,
			recoveryGuidance: currentTurnPacket.recoveryGuidance,
			activeTurnOrder: currentTurnPacket.activeTurnOrder,
			sourcePaths: currentTurnPacket.sourcePaths,
			nextCommands: currentTurnPacket.nextCommands,
			commandBlock: currentTurnPacket.nextCommands.join("\n"),
			budget: currentTurnPacket.budget,
			turn: currentTurnPacket.turn,
		};
	}

	/**
	 * current turn packet을 파일 저장용 payload로 묶습니다.
	 */
	fileReadyPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillFileReadyPacketResult {
		const markdownPacket = this.markdownPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const checklistPacket = this.checklistPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const commandsPacket = this.commandsPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const baseName = `${markdownPacket.winner ?? "skill"}-turn-${markdownPacket.activeTurnOrder ?? "current"}`;
		const files = [
			{
				kind: "markdown" as const,
				suggestedPath: `packets/${baseName}.md`,
				mediaType: "text/markdown" as const,
				content: markdownPacket.markdown,
			},
			{
				kind: "checklist" as const,
				suggestedPath: `packets/${baseName}.checklist.md`,
				mediaType: "text/markdown" as const,
				content:
					checklistPacket.checklistItems.length > 0
						? checklistPacket.checklistItems.map((item) => `- ${item}`).join("\n")
						: checklistPacket.checklistText || "-",
			},
			{
				kind: "commands" as const,
				suggestedPath: `packets/${baseName}.commands.txt`,
				mediaType: "text/plain" as const,
				content: commandsPacket.commandBlock || "-",
			},
		];
		return {
			query: markdownPacket.query,
			basis: markdownPacket.basis,
			relationMode: markdownPacket.relationMode,
			winner: markdownPacket.winner,
			ready: markdownPacket.ready,
			applyHint: markdownPacket.applyHint,
			recoveryGuidance: markdownPacket.recoveryGuidance,
			activeTurnOrder: markdownPacket.activeTurnOrder,
			baseName,
			sourcePaths: markdownPacket.sourcePaths,
			nextCommands: markdownPacket.nextCommands,
			files,
			budget: markdownPacket.budget,
			turn: markdownPacket.turn,
		};
	}

	/**
	 * file-ready-packet을 write/apply payload로 투영합니다.
	 */
	applyPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillApplyPacketResult {
		const fileReadyPacket = this.fileReadyPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const writes = fileReadyPacket.files.map((file) => ({
			kind: "write" as const,
			sourceKind: file.kind,
			path: file.suggestedPath,
			mediaType: file.mediaType,
			content: file.content,
		}));
		const applyText = writes.length
			? writes.map((write, indexPosition) => `${indexPosition + 1}. write ${write.path} (${write.sourceKind})`).join("\n")
			: "write 작업 없음";
		return {
			query: fileReadyPacket.query,
			basis: fileReadyPacket.basis,
			relationMode: fileReadyPacket.relationMode,
			winner: fileReadyPacket.winner,
			ready: fileReadyPacket.ready,
			applyHint: fileReadyPacket.applyHint,
			recoveryGuidance: fileReadyPacket.recoveryGuidance,
			activeTurnOrder: fileReadyPacket.activeTurnOrder,
			baseName: fileReadyPacket.baseName,
			sourcePaths: fileReadyPacket.sourcePaths,
			nextCommands: fileReadyPacket.nextCommands,
			writes,
			applyText,
			budget: fileReadyPacket.budget,
			turn: fileReadyPacket.turn,
		};
	}

	/**
	 * apply-packet을 실행 가능한 write script payload로 투영합니다.
	 */
	writeScriptPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillWriteScriptPacketResult {
		const applyPacket = this.applyPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const scriptPath = `packets/${applyPacket.baseName}.write.ts`;
		const scriptContent = [
			"/** apply-packet write script 입니다. */",
			'import { mkdir } from "node:fs/promises";',
			'import path from "node:path";',
			"",
			`const writes = ${JSON.stringify(applyPacket.writes, null, 2)} as const;`,
			"",
			"for (const write of writes) {",
			"\tawait mkdir(path.dirname(write.path), { recursive: true });",
			"\tawait Bun.write(write.path, write.content);",
			'\tconsole.log("wrote " + write.path + " (" + write.sourceKind + ")");',
			"}",
		].join("\n");
		const commandBlock = `bun ${scriptPath}`;
		return {
			query: applyPacket.query,
			basis: applyPacket.basis,
			relationMode: applyPacket.relationMode,
			winner: applyPacket.winner,
			ready: applyPacket.ready,
			applyHint: applyPacket.applyHint,
			recoveryGuidance: applyPacket.recoveryGuidance,
			activeTurnOrder: applyPacket.activeTurnOrder,
			baseName: applyPacket.baseName,
			sourcePaths: applyPacket.sourcePaths,
			nextCommands: applyPacket.nextCommands,
			writes: applyPacket.writes,
			scriptPath,
			scriptContent,
			commandBlock,
			budget: applyPacket.budget,
			turn: applyPacket.turn,
		};
	}

	/**
	 * write-script-packet을 script file + run command bundle로 투영합니다.
	 */
	executionPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillExecutionPacketResult {
		const writeScriptPacket = this.writeScriptPacketSkills(
			index,
			query,
			names,
			relationMode,
			budgetChars,
			budgetTokens,
			limit,
			minScore,
		);
		const files = [
			{
				kind: "script" as const,
				path: writeScriptPacket.scriptPath,
				mediaType: "text/typescript" as const,
				content: writeScriptPacket.scriptContent,
			},
		];
		const runCommands = [writeScriptPacket.commandBlock].filter(Boolean);
		const executionText = [
			`1. Write script file: ${writeScriptPacket.scriptPath}`,
			`2. Run command: ${writeScriptPacket.commandBlock}`,
			`3. Expect ${writeScriptPacket.writes.length} file write operations.`,
		].join("\n");
		return {
			query: writeScriptPacket.query,
			basis: writeScriptPacket.basis,
			relationMode: writeScriptPacket.relationMode,
			winner: writeScriptPacket.winner,
			ready: writeScriptPacket.ready,
			applyHint: writeScriptPacket.applyHint,
			recoveryGuidance: writeScriptPacket.recoveryGuidance,
			activeTurnOrder: writeScriptPacket.activeTurnOrder,
			baseName: writeScriptPacket.baseName,
			sourcePaths: writeScriptPacket.sourcePaths,
			nextCommands: writeScriptPacket.nextCommands,
			files,
			runCommands,
			executionText,
			budget: writeScriptPacket.budget,
			turn: writeScriptPacket.turn,
		};
	}

	/**
	 * execution-packet을 검증 checklist bundle로 투영합니다.
	 */
	verificationPacketSkills(
		index: IndexArtifacts,
		query: string | undefined,
		names: string[],
		relationMode: SkillRelationMode = "full",
		budgetChars = 8_000,
		budgetTokens = 2_000,
		limit = index.settings.maxTopK,
		minScore = 0,
	): SkillVerificationPacketResult {
		const executionPacket = this.executionPacketSkills(index, query, names, relationMode, budgetChars, budgetTokens, limit, minScore);
		const verificationItems = executionPacket.turn?.exitCriteria.length
			? executionPacket.turn.exitCriteria
			: ["Run command completed without write errors."];
		const verificationCommands = executionPacket.runCommands;
		const verificationText = [
			"Run:",
			verificationCommands.length ? verificationCommands.join("\n") : "-",
			"",
			"Verify:",
			verificationItems.length ? verificationItems.map((item, indexPosition) => `${indexPosition + 1}. ${item}`).join("\n") : "-",
		].join("\n");
		return {
			query: executionPacket.query,
			basis: executionPacket.basis,
			relationMode: executionPacket.relationMode,
			winner: executionPacket.winner,
			ready: executionPacket.ready,
			applyHint: executionPacket.applyHint,
			recoveryGuidance: executionPacket.recoveryGuidance,
			activeTurnOrder: executionPacket.activeTurnOrder,
			baseName: executionPacket.baseName,
			sourcePaths: executionPacket.sourcePaths,
			nextCommands: executionPacket.nextCommands,
			files: executionPacket.files,
			runCommands: executionPacket.runCommands,
			verificationCommands,
			verificationItems,
			verificationText,
			budget: executionPacket.budget,
			turn: executionPacket.turn,
		};
	}
}
