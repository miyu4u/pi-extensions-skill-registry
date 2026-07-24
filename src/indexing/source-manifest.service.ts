import { createHash } from "node:crypto";
import path from "node:path";
import type { SkillSourceScanResult, SourceManifestInterface } from "./source-manifest.interface";

/**
 * OS별 separator 차이를 제거하고 absolute path identity를 고정합니다.
 */
const normalizeManifestPath = (value: string): string => path.resolve(value).replaceAll(path.sep, "/");

/**
 * Source body를 읽지 않고 path, size, mtime 기반 freshness identity를 만듭니다.
 */
export class SourceManifestService implements SourceManifestInterface {
	/**
	 * Enumeration 순서와 무관한 JSON payload를 SHA-256으로 축약합니다.
	 */
	createSignature(scans: readonly SkillSourceScanResult[]): string {
		const manifest = scans
			.map((scan) => ({
				root: normalizeManifestPath(scan.root),
				missingRoot: scan.missingRoot,
				mode: scan.mode,
				files: scan.sourceFiles
					.map((file) => ({
						path: normalizeManifestPath(file.path),
						size: file.size,
						mtimeMs: file.mtimeMs,
					}))
					.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
			}))
			.sort((left, right) => (left.root < right.root ? -1 : left.root > right.root ? 1 : 0));

		return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
	}
}
