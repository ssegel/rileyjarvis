"use strict";

/**
 * Shared Jarvis instructions + personal memory + thumbnail board state
 * for Realtime token mint and independent text turns.
 */
async function buildSessionInstructions(options) {
  const {
    jarvisInstructions,
    memoryStore,
    readDb,
    buildThumbnailBoardInstructions,
  } = options;
  const db = await readDb();
  const personalContext = await memoryStore.buildPersonalContextForSession();
  return `${jarvisInstructions}\n\n${personalContext.text}\n\n${buildThumbnailBoardInstructions(db)}`;
}

module.exports = {
  buildSessionInstructions,
};
