import fs from 'node:fs'
import path from 'node:path'
import type { SkillSourceFileIdentity, SkillSourceScanResult } from './source-manifest.interface'

const SKIP_DIRECTORY_NAMES: Record<string, true> = {
  '.git': true,
  '.svn': true,
  node_modules: true,
  '.venv': true,
  dist: true,
  build: true,
  out: true,
}

/** Skill 문서 후보를 filesystem에서 수집합니다. */
export class SkillFileScanner {
  scan(root: string, fileNames: string[], requestedSet: Set<string>): SkillSourceScanResult {
    try {
      if (!fs.statSync(root).isDirectory()) {
        return {
          root,
          missingRoot: true,
          mode: requestedSet.size > 0 ? 'targeted' : 'full',
          files: [],
          sourceFiles: [],
        }
      }
    } catch {
      return {
        root,
        missingRoot: true,
        mode: requestedSet.size > 0 ? 'targeted' : 'full',
        files: [],
        sourceFiles: [],
      }
    }

    const result = this.collectSkillFiles(root, fileNames, requestedSet)
    const sourceFiles = this.collectSourceFileIdentities(result.files)
    return {
      root,
      missingRoot: false,
      mode: result.mode,
      files: sourceFiles.map((file) => file.path),
      sourceFiles,
    }
  }

  /**
   * Traversal과 parsing 사이에 사라진 file은 현재 manifest와 build 모두에서 제외합니다.
   */
  private collectSourceFileIdentities(files: readonly string[]): SkillSourceFileIdentity[] {
    const sourceFiles: SkillSourceFileIdentity[] = []
    for (const file of files) {
      try {
        const stat = fs.statSync(file)
        if (stat.isFile()) {
          sourceFiles.push({ path: file, size: stat.size, mtimeMs: stat.mtimeMs })
        }
      } catch {
        // 다음 요청의 manifest scan이 concurrent filesystem 변경을 다시 관측합니다.
      }
    }
    return sourceFiles
  }

  /**
   * 지정된 요청 이름(Set)을 기반으로 대상 파일들을 수집하며, 직접 해결되지 않은 이름이 있으면 전체 스캔으로 대체합니다.
   */
  private collectSkillFiles(root: string, fileNames: string[], requestedSet: Set<string>): { mode: 'targeted' | 'full'; files: string[] } {
    if (requestedSet.size === 0) {
      return { mode: 'full', files: this.findSkillFiles(root, fileNames) }
    }
    const targeted: string[] = []
    const dedupe = new Set<string>()
    const directlyResolved = new Set<string>()
    const extensions = Array.from(new Set(fileNames.map((name) => path.extname(name).toLowerCase())))

    const context = {
      root,
      fileNames,
      extensions,
      dedupe,
      targeted,
      directlyResolved,
    }

    for (const requestedName of requestedSet) {
      this.resolveTargetedName(requestedName, context)
    }

    if (targeted.length > 0 && directlyResolved.size === requestedSet.size) {
      return { mode: 'targeted', files: targeted }
    }
    return { mode: 'full', files: this.findSkillFiles(root, fileNames) }
  }

  /**
   * 특정 요청 이름에 대해 디렉터리 내 직접 매칭 및 확장자 접미사 기반 파일 매칭을 수행합니다.
   */
  private resolveTargetedName(
    requestedName: string,
    context: {
      root: string
      fileNames: string[]
      extensions: string[]
      dedupe: Set<string>
      targeted: string[]
      directlyResolved: Set<string>
    },
  ): void {
    if (!this.isSafeRequestedName(requestedName)) {
      return
    }
    this.resolveTargetedDirEntries(requestedName, context)
    this.resolveTargetedExtensions(requestedName, context)
  }

  /**
   * 요청 이름의 디렉터리 경로 내에 지정된 파일 이름들과 일치하는 파일들을 매칭합니다.
   */
  private resolveTargetedDirEntries(
    requestedName: string,
    context: {
      root: string
      fileNames: string[]
      dedupe: Set<string>
      targeted: string[]
      directlyResolved: Set<string>
    },
  ): void {
    const candidateDir = path.join(context.root, requestedName)
    let dirEntries: fs.Dirent[]
    try {
      dirEntries = fs.readdirSync(candidateDir, { withFileTypes: true })
    } catch {
      dirEntries = []
    }

    for (const entry of dirEntries) {
      if (entry.isFile() && context.fileNames.includes(entry.name)) {
        const skillFile = path.join(candidateDir, entry.name)
        if (!context.dedupe.has(skillFile)) {
          context.dedupe.add(skillFile)
          context.targeted.push(skillFile)
        }
        context.directlyResolved.add(requestedName)
      }
    }
  }

  /**
   * 루트 디렉터리에 요청 이름과 파일 확장자가 조합된 이름으로 파일이 존재하는지 검사하고 매칭합니다.
   */
  private resolveTargetedExtensions(
    requestedName: string,
    context: {
      root: string
      extensions: string[]
      dedupe: Set<string>
      targeted: string[]
      directlyResolved: Set<string>
    },
  ): void {
    for (const ext of context.extensions) {
      if (!ext) {
        continue
      }
      const skillFile = path.join(context.root, `${requestedName}${ext}`)
      try {
        if (fs.statSync(skillFile).isFile()) {
          if (!context.dedupe.has(skillFile)) {
            context.dedupe.add(skillFile)
            context.targeted.push(skillFile)
          }
          context.directlyResolved.add(requestedName)
        }
      } catch {
        // 파일이 존재하지 않는 경우 무시
      }
    }
  }

  /**
   * Targeted lookup은 corpus root 바로 아래의 canonical name 한 segment만 허용합니다.
   */
  private isSafeRequestedName(requestedName: string): boolean {
    return (
      requestedName.length > 0 &&
      requestedName !== '.' &&
      requestedName !== '..' &&
      !path.isAbsolute(requestedName) &&
      !requestedName.includes('/') &&
      !requestedName.includes('\\')
    )
  }

  /**
   * 파일 시스템을 LIFO 스택 방식으로 재귀 탐색하여 대상 파일 목록을 찾습니다.
   */
  private findSkillFiles(root: string, fileNames: string[]): string[] {
    const found: string[] = []
    const stack = [root]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current) {
        this.processDirectoryEntries(current, fileNames, stack, found)
      }
    }
    return found
  }

  /**
   * 특정 디렉터리의 항목들을 확인하여, 디렉터리인 경우 스택에 추가하고 파일인 경우 대상 이름을 비교해 매칭 목록에 추가합니다.
   */
  private processDirectoryEntries(current: string, fileNames: string[], stack: string[], found: string[]): void {
    let dirEntries: fs.Dirent[]
    try {
      dirEntries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of dirEntries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORY_NAMES[entry.name]) {
          stack.push(path.join(current, entry.name))
        }
      } else if (entry.isFile() && fileNames.includes(entry.name)) {
        found.push(path.join(current, entry.name))
      }
    }
  }
}
