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
} from "./indexing";
import { PromptGuidanceService } from "./prompt/prompt-guidance.service";
import { SkillReadResultCompactorService } from "./results";
import { SettingsLoaderService } from "./settings/settings-loader.service";
import { EnglishFuzzyMatcherService } from "./tokenization/english-fuzzy-matcher.service";
import { KoreanMorphologyAnalyzerService } from "./tokenization/korean-morphology-analyzer.service";
import { SearchTokenizerService } from "./tokenization/search-tokenizer.service";

const settingsLoader = new SettingsLoaderService();
const englishFuzzyMatcher = new EnglishFuzzyMatcherService();
const koreanMorphologyAnalyzer = new KoreanMorphologyAnalyzerService();
const searchTokenizer = new SearchTokenizerService(englishFuzzyMatcher, koreanMorphologyAnalyzer);
const promptGuidance = new PromptGuidanceService();
const skillReadResultCompactor = new SkillReadResultCompactorService();
export const createSkillSearchDatabaseService = (): SkillSearchDatabaseService => new SkillSearchDatabaseService();

const skillSearchDatabase = createSkillSearchDatabaseService();
const skillScopeResolver = new SkillScopeResolverService();
const skillInputNormalizer = new SkillInputNormalizer(settingsLoader, skillScopeResolver);
const skillFileScanner = new SkillFileScanner();
const skillDocumentParser = new SkillDocumentParser();
const activeIndexStore = new ActiveIndexStore();
const skillSearchEngine = new SkillSearchEngine(skillSearchDatabase, searchTokenizer, activeIndexStore);
const skillRelationEngine = new SkillRelationEngine(skillSearchEngine);
const skillIndexDiagnostics = new SkillIndexDiagnostics(skillRelationEngine);
const skillDecisionEngine = new SkillDecisionEngine(skillSearchEngine, skillRelationEngine);
const skillReadPacketBuilder = new SkillReadPacketBuilder(skillRelationEngine, skillIndexDiagnostics, skillDecisionEngine);
const skillExecutionPacketBuilder = new SkillExecutionPacketBuilder(skillReadPacketBuilder);
const skillIndexLoader = new SkillIndexLoader(
	skillSearchDatabase,
	searchTokenizer,
	skillFileScanner,
	skillDocumentParser,
	activeIndexStore,
	skillScopeResolver,
);
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
} as const;
