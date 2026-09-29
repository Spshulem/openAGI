import fs from "node:fs";
import path from "node:path";
import { readJsonFile, writeJsonAtomic } from "./file-utils.js";

const SCHEMA = "openagi.chatgpt-model-selection.v1";
const MODEL_PATTERN = /^[a-zA-Z0-9_.-]{1,100}$/;
const GENERATION_PATTERN = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function chatGptModelSelectionPath(dataDir) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) {
    throw new TypeError("ChatGPT model selection requires an absolute data directory.");
  }
  return path.join(dataDir, "chatgpt-host-oauth", "model-selection.json");
}

function isSelection(value) {
  return Boolean(value && value.schema === SCHEMA
    && typeof value.model === "string" && MODEL_PATTERN.test(value.model)
    && typeof value.credentialGeneration === "string" && GENERATION_PATTERN.test(value.credentialGeneration));
}

export function readChatGptModelSelection(dataDir) {
  const value = readJsonFile(chatGptModelSelectionPath(dataDir), null, { quarantine: false });
  return isSelection(value) ? value : null;
}

export function writeChatGptModelSelection({ dataDir, model, credentialGeneration }) {
  const value = { schema: SCHEMA, model, credentialGeneration };
  if (!isSelection(value)) throw new TypeError("Invalid ChatGPT model selection attestation.");
  writeJsonAtomic(chatGptModelSelectionPath(dataDir), value);
  return value;
}

export function clearChatGptModelSelection(dataDir) {
  try {
    fs.unlinkSync(chatGptModelSelectionPath(dataDir));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
