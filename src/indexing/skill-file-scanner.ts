import fs from "node:fs";
import path from "node:path";

const SKIP_DIRECTORY_NAMES: Record<string, true> = {
	".git": true,
	".svn": true,
	node_modules: true,
	".venv": true,
	dist: true,
	build: true,
	out: true,
};

export interface SkillFileScanResult {
	missingRoot: boolean;
	mode: "targeted" | "full";
	files: string[];
}

/** Skill 문서 후보를 filesystem에서 수집합니다. */
export class SkillFileScanner {
	scan(root: string, fileNames: string[], requestedSet: Set<string>): SkillFileScanResult {
		try {
			if (!fs.statSync(root).isDirectory()) {
				return { missingRoot: true, mode: requestedSet.size > 0 ? "targeted" : "full", files: [] };
			}
		} catch {
			return { missingRoot: true, mode: requestedSet.size > 0 ? "targeted" : "full", files: [] };
		}

		const result = this.collectSkillFiles(root, fileNames, requestedSet);
		return { missingRoot: false, ...result };
	}

	private collectSkillFiles(
		root: string,
		fileNames: string[],
		requestedSet: Set<string>,
	): { mode: "targeted" | "full"; files: string[] } {
		if (requestedSet.size === 0) {
			return { mode: "full", files: this.findSkillFiles(root, fileNames) };
		}
		const targeted: string[] = [];
		const dedupe = new Set<string>();
		const directlyResolvedRequestedNames = new Set<string>();
		const extensions = Array.from(new Set(fileNames.map((fileName) => path.extname(fileName).toLowerCase())));

		for (const requestedName of requestedSet) {
			const candidateDir = path.join(root, requestedName);
			let dirEntries: fs.Dirent[];
			try {
				dirEntries = fs.readdirSync(candidateDir, { withFileTypes: true });
			} catch {
				dirEntries = [];
			}

			for (const entry of dirEntries) {
				if (!entry.isFile() || !fileNames.includes(entry.name)) {
					continue;
				}
				const skillFile = path.join(candidateDir, entry.name);
				if (!dedupe.has(skillFile)) {
					dedupe.add(skillFile);
					targeted.push(skillFile);
				}
				directlyResolvedRequestedNames.add(requestedName);
			}

			for (const ext of extensions) {
				if (!ext) {
					continue;
				}
				const skillFile = path.join(root, `${requestedName}${ext}`);
				try {
					if (fs.statSync(skillFile).isFile()) {
						if (!dedupe.has(skillFile)) {
							dedupe.add(skillFile);
							targeted.push(skillFile);
						}
						directlyResolvedRequestedNames.add(requestedName);
					}
				} catch {
					// not found
				}
			}
		}

		if (targeted.length > 0 && directlyResolvedRequestedNames.size === requestedSet.size) {
			return { mode: "targeted", files: targeted };
		}
		return { mode: "full", files: this.findSkillFiles(root, fileNames) };
	}

	private findSkillFiles(root: string, fileNames: string[]): string[] {
		const found: string[] = [];
		const stack = [root];
		while (stack.length > 0) {
			const current = stack.pop();
			if (!current) {
				continue;
			}
			let dirEntries: fs.Dirent[];
			try {
				dirEntries = fs.readdirSync(current, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const entry of dirEntries) {
				if (entry.isDirectory()) {
					if (!SKIP_DIRECTORY_NAMES[entry.name]) {
						stack.push(path.join(current, entry.name));
					}
					continue;
				}
				if (entry.isFile() && fileNames.includes(entry.name)) {
					found.push(path.join(current, entry.name));
				}
			}
		}
		return found;
	}
}
