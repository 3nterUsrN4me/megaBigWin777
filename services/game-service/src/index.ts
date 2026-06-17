export { GameService } from "./GameService.js";
export type {
  ApplyPlayerActionOk,
  ApplyPlayerActionResult,
  CreateGameOk,
  CreateGameParams,
  CreateGameResult,
  ServiceError,
  ServiceErrorCode,
} from "./GameService.js";

export { db, closeDbPool, pool } from "./db/client.js";
export type { Database, Transaction } from "./db/client.js";
export * from "./db/schema.js";

export { GameRepository } from "./repositories/GameRepository.js";
export { PlayerRepository } from "./repositories/PlayerRepository.js";

export {
  ALLOWED_ACTIONS,
  availableActionsForGame,
  cardsToHand,
  revealDealerHand,
  rowToGameState,
  toGameStateView,
} from "./mappers/gameStateMapper.js";
export type { GameStateView } from "./mappers/gameStateMapper.js";
