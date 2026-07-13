import { SkillDocumentParser } from "./indexing/skill-document-parser";
import { SkillFileScanner } from "./indexing/skill-file-scanner";
import { SkillIndexDiagnostics } from "./indexing/skill-index-diagnostics";
import { SkillIndexLoader } from "./indexing/skill-index-loader";
import { SkillInputNormalizer } from "./indexing/skill-input-normalizer";
import { SkillReadPacketBuilder } from "./indexing/skill-read-packet-builder";
import { SkillRelationEngine } from "./indexing/skill-relation-engine";
import { SkillSearchDatabaseService } from "./indexing/skill-search-database.service";
import { SkillSearchEngine } from "./indexing/skill-search-engine";
import { PromptGuidanceService } from "./prompt/prompt-guidance.service";
import { SettingsLoaderService } from "./settings/settings-loader.service";
import { EnglishFuzzyMatcherService } from "./tokenization/english-fuzzy-matcher.service";
import { KoreanMorphologyAnalyzerService } from "./tokenization/korean-morphology-analyzer.service";
import { SearchTokenizerService } from "./tokenization/search-tokenizer.service";

const settingsLoader = new SettingsLoaderService();
const englishFuzzyMatcher = new EnglishFuzzyMatcherService();
const koreanMorphologyAnalyzer = new KoreanMorphologyAnalyzerService();
const searchTokenizer = new SearchTokenizerService(englishFuzzyMatcher, koreanMorphologyAnalyzer);
const promptGuidance = new PromptGuidanceService();
export const createSkillSearchDatabaseService = (): SkillSearchDatabaseService => new SkillSearchDatabaseService();

const skillSearchDatabase = createSkillSearchDatabaseService();
const skillInputNormalizer = new SkillInputNormalizer(settingsLoader);
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
);

export const SERVICE = {
	settingsLoader,
	englishFuzzyMatcher,
	koreanMorphologyAnalyzer,
	searchTokenizer,
	promptGuidance,
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
} as const;

import { ActiveIndexStore } from "./indexing/active-index-store";
import { SkillDecisionEngine } from "./indexing/skill-decision-engine";
import { SkillExecutionPacketBuilder } from "./indexing/skill-execution-packet-builder";
