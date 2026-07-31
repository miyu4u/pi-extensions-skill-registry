import { describe, expect, jest, test } from '@jest/globals'
import type { SkillIndexLoader } from '../indexing/skill-index-loader'
import type { SkillInputNormalizer } from '../indexing/skill-input-normalizer'
import type { SkillSearchEngine } from '../indexing/skill-search-engine'
import type { IndexArtifacts, ToolContext } from '../shared'

jest.unstable_mockModule('../results', () => ({
  buildDiscoverResult: jest.fn().mockReturnValue({
    content: [{ type: 'text', text: 'matching skills found' }],
    details: { mocked: true },
  }),
}))

// Static import cannot work because Jest ESM requires dynamic import after jest.unstable_mockModule
const { DiscoverCommandService } = await import('./discover-command.service')

describe('DiscoverCommandService', () => {
  test('should reject empty/whitespace queries without making any downstream calls', async () => {
    const mockNormalizeToolInput = jest.fn()
    const mockLoadIndex = jest.fn()
    const mockSearchWithDiagnostics = jest.fn()

    const deps = {
      inputNormalizer: { normalizeToolInput: mockNormalizeToolInput } as unknown as SkillInputNormalizer,
      indexLoader: { loadIndex: mockLoadIndex } as unknown as SkillIndexLoader,
      searchEngine: { searchWithDiagnostics: mockSearchWithDiagnostics } as unknown as SkillSearchEngine,
    }

    const service = new DiscoverCommandService(deps)
    const result = await service.execute({ args: '   ' })

    expect(mockNormalizeToolInput).not.toHaveBeenCalled()
    expect(mockLoadIndex).not.toHaveBeenCalled()
    expect(mockSearchWithDiagnostics).not.toHaveBeenCalled()
    expect(result).toEqual({
      kind: 'discover',
      status: 'error',
      message: 'discover 실행 오류: 검색어가 비어 있습니다.',
    })
  })

  test('should delegate the trimmed query and call downstream dependencies', async () => {
    const mockNormalizeToolInput = jest.fn<(params: unknown) => ToolContext>().mockReturnValue({
      action: 'discover',
      query: 'git workflow',
      limit: 5,
      minScore: 0.5,
    } as unknown as ToolContext)

    const mockIndex = {} as unknown as IndexArtifacts
    const mockLoadIndex = jest.fn<(context: ToolContext) => Promise<IndexArtifacts>>().mockResolvedValue(mockIndex)

    const mockSearchResult = {
      hits: [],
      diagnostics: { queryTimeMs: 1 },
    }
    const mockSearchWithDiagnostics = jest.fn().mockReturnValue(mockSearchResult)

    const deps = {
      inputNormalizer: { normalizeToolInput: mockNormalizeToolInput } as unknown as SkillInputNormalizer,
      indexLoader: { loadIndex: mockLoadIndex } as unknown as SkillIndexLoader,
      searchEngine: { searchWithDiagnostics: mockSearchWithDiagnostics } as unknown as SkillSearchEngine,
    }

    const service = new DiscoverCommandService(deps)
    const result = await service.execute({ args: '  git workflow  ' })

    expect(mockNormalizeToolInput).toHaveBeenCalledWith({
      action: 'discover',
      query: 'git workflow',
    })
    expect(mockLoadIndex).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'discover',
        query: 'git workflow',
        limit: 5,
        minScore: 0.5,
      }),
    )
    expect(mockSearchWithDiagnostics).toHaveBeenCalledWith(mockIndex, 'git workflow', 5, 0.5)
    expect(result).toEqual({
      kind: 'discover',
      status: 'success',
      message: 'matching skills found',
      details: { mocked: true },
    })
  })
})
