import { DiagnosticsCommandService, DiscoverCommandService, ReindexCommandService } from './commands'
import {
  ActiveIndexStore,
  SkillDecisionEngine,
  SkillDocumentParser,
  SkillExecutionPacketBuilder,
  SkillFileScanner,
  SkillIndexDiagnostics,
  SkillIndexLoader,
  SkillInputNormalizer,
  SkillReadPacketBuilder,
  SkillRelationEngine,
  SkillScopeResolverService,
  SkillSearchDatabaseService,
  SkillSearchEngine,
  SourceManifestService,
} from './indexing'
import { PromptGuidanceService } from './prompt/prompt-guidance.service'
import { SkillReadResultCompactorService } from './results'
import { SettingsLoaderService } from './settings/settings-loader.service'
import { englishFuzzyMatcher, koreanMorphologyAnalyzer, SearchTokenizerService } from './tokenization'

const settingsLoader = new SettingsLoaderService()
const promptGuidance = new PromptGuidanceService(settingsLoader)
const skillReadResultCompactor = new SkillReadResultCompactorService()
/**
 * 검색용 영어·한국어 토큰화 서비스를 조합해 애플리케이션 전역에서 공유합니다.
 */
export const searchTokenizer = new SearchTokenizerService()
export const createSkillSearchDatabaseService = (): SkillSearchDatabaseService => new SkillSearchDatabaseService()

const skillSearchDatabase = createSkillSearchDatabaseService()
const skillScopeResolver = new SkillScopeResolverService()
const skillInputNormalizer = new SkillInputNormalizer(settingsLoader, skillScopeResolver)
const skillFileScanner = new SkillFileScanner()
/** Filesystem stat identity를 cache freshness signature로 축약합니다. */
const sourceManifest = new SourceManifestService()
const skillDocumentParser = new SkillDocumentParser()
const activeIndexStore = new ActiveIndexStore()
const skillSearchEngine = new SkillSearchEngine(skillSearchDatabase, searchTokenizer, activeIndexStore)
const skillRelationEngine = new SkillRelationEngine(skillSearchEngine)
const skillIndexDiagnostics = new SkillIndexDiagnostics(skillRelationEngine)
const skillDecisionEngine = new SkillDecisionEngine(skillSearchEngine, skillRelationEngine)
const skillReadPacketBuilder = new SkillReadPacketBuilder(skillRelationEngine, skillIndexDiagnostics, skillDecisionEngine)
const skillExecutionPacketBuilder = new SkillExecutionPacketBuilder(skillReadPacketBuilder)
const skillIndexLoader = new SkillIndexLoader({
  searchDatabase: skillSearchDatabase,
  searchTokenizer,
  fileScanner: skillFileScanner,
  documentParser: skillDocumentParser,
  activeIndexStore,
  scopeResolver: skillScopeResolver,
  sourceManifest,
})
const reindexCommand = new ReindexCommandService({
  inputNormalizer: skillInputNormalizer,
  indexLoader: skillIndexLoader,
})
const discoverCommand = new DiscoverCommandService({
  inputNormalizer: skillInputNormalizer,
  indexLoader: skillIndexLoader,
  searchEngine: skillSearchEngine,
})
const diagnosticsCommand = new DiagnosticsCommandService({
  inputNormalizer: skillInputNormalizer,
  indexLoader: skillIndexLoader,
  indexDiagnostics: skillIndexDiagnostics,
})
export const SERVICE = {
  settingsLoader,
  englishFuzzyMatcher,
  koreanMorphologyAnalyzer,
  searchTokenizer,
  promptGuidance,
  skillReadResultCompactor,
  skillSearchDatabase,
  skillInputNormalizer,
  skillFileScanner,
  skillDocumentParser,
  skillIndexLoader,
  skillSearchEngine,
  skillRelationEngine,
  skillIndexDiagnostics,
  skillDecisionEngine,
  skillReadPacketBuilder,
  skillExecutionPacketBuilder,
  skillScopeResolver,
  reindexCommand,
  discoverCommand,
  diagnosticsCommand,
} as const
