import fs from "node:fs";
import path from "node:path";
import { KNOWN_PLANNING_CANONICALS, PLANNING_DISCOVER_QUERY } from "./constants";

/**
 * deterministic planning fixture 문서 한 건의 최소 frontmatter와 body를 구성합니다.
 */
function renderPlanningSkillMarkdown(name: string): string {
	return [
		"---",
		`name: ${name}`,
		"description: Deterministic planning skill fixture for runtime verification",
		"category: planning",
		"keywords:",
		"  - planning",
		"  - implementation",
		"  - plans",
		"  - architecture",
		"  - task",
		"  - decomposition",
		"---",
		`# ${name}`,
		"",
		`${PLANNING_DISCOVER_QUERY}.`,
		"",
		"Minimal deterministic body for discover, index, and exact resolve gates.",
	].join("\n");
}

/**
 * 임시 corpus root 아래에 known planning skill 3개를 SKILL.md로 작성합니다.
 */
export function writePlanningFixtureCorpus(root: string): string[] {
	fs.mkdirSync(root, { recursive: true });
	const writtenPaths: string[] = [];
	for (const name of KNOWN_PLANNING_CANONICALS) {
		const skillDirectory = path.join(root, name);
		fs.mkdirSync(skillDirectory, { recursive: true });
		const skillPath = path.join(skillDirectory, "SKILL.md");
		fs.writeFileSync(skillPath, renderPlanningSkillMarkdown(name), "utf8");
		writtenPaths.push(skillPath);
	}
	return writtenPaths;
}
