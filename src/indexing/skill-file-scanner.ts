import fs from "node:fs";
import path from "node:path";
import type { SkillSourceFileIdentity, SkillSourceScanResult } from "./source-manifest.interface";

const SKIP_DIRECTORY_NAMES: Record<string, true> = {
	".git": true,
	".svn": true,
	node_modules: true,
	".venv": true,
	dist: true,
	build: true,
	out: true,
};

/** Skill 문서 후보를 filesystem에서 수집합니다. */
export class SkillFileScanner {
	scan(root: string, fileNames: string[], requestedSet: Set<string>): SkillSourceScanResult {
		try {
			if (!fs.statSync(root).isDirectory()) {
				return {
					root,
					missingRoot: true,
					mode: requestedSet.size > 0 ? "targeted" : "full",
					files: [],
					sourceFiles: [],
				};
			}
		} catch {
			return {
				root,
				missingRoot: true,
				mode: requestedSet.size > 0 ? "targeted" : "full",
				files: [],
				sourceFiles: [],
			};
		}

		const result = this.collectSkillFiles(root, fileNames, requestedSet);
		const sourceFiles = this.collectSourceFileIdentities(result.files);
		return {
			root,
			missingRoot: false,
			mode: result.mode,
			files: sourceFiles.map((file) => file.path),
			sourceFiles,
		};
	}

	/**
	 * Traversal과 parsing 사이에 사라진 file은 현재 manifest와 build 모두에서 제외합니다.
	 */
	private collectSourceFileIdentities(files: readonly string[]): SkillSourceFileIdentity[] {
		const sourceFiles: SkillSourceFileIdentity[] = [];
		for (const file of files) {
			try {
				const stat = fs.statSync(file);
				if (stat.isFile()) {
					sourceFiles.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs });
				}
			} catch {
				// 다음 요청의 manifest scan이 concurrent filesystem 변경을 다시 관측합니다.
			}
		}
		return sourceFiles;
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
			if (!this.isSafeRequestedName(requestedName)) {
				continue;
			}
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

	/**
	 * Targeted lookup은 corpus root 바로 아래의 canonical name 한 segment만 허용합니다.
	 */
	private isSafeRequestedName(requestedName: string): boolean {
		return (
			requestedName.length > 0 &&
			requestedName !== "." &&
			requestedName !== ".." &&
			!path.isAbsolute(requestedName) &&
			!requestedName.includes("/") &&
			!requestedName.includes("\\")
		);
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
