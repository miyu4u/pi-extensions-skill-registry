// biome-ignore lint/performance/noBarrelFile: Command concern은 repository module boundary를 index.ts로 노출해야 합니다.
export { DiagnosticsCommandService, type DiagnosticsCommandDependencies } from './diagnostics-command.service'
export { DiscoverCommandService, type DiscoverCommandDependencies } from './discover-command.service'
export type { RegistryCommandContract } from './registry-command.interface'
export {
  RegistryCommandRequestSchema,
  RegistryCommandResultSchema,
  type RegistryCommandRequest,
  type RegistryCommandResult,
} from './registry-command.schema'
export { ReindexCommandService, type ReindexCommandDependencies } from './reindex-command.service'
