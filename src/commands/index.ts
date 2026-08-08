// biome-ignore lint/performance/noBarrelFile: Command concern은 repository module boundary를 index.ts로 노출해야 합니다.
export { type DiagnosticsCommandDependencies, DiagnosticsCommandService } from './diagnostics-command.service'
export { type DiscoverCommandDependencies, DiscoverCommandService } from './discover-command.service'
export type { RegistryCommandContract } from './registry-command.interface'
export {
  type RegistryCommandRequest,
  RegistryCommandRequestSchema,
  type RegistryCommandResult,
  RegistryCommandResultSchema,
} from './registry-command.schema'
export { type ReindexCommandDependencies, ReindexCommandService } from './reindex-command.service'
